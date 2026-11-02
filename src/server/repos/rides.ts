import { and, asc, count, desc, eq, gt, inArray, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  chatMessages,
  conversationParticipants,
  conversations,
  rideRequests,
  rides,
  users,
} from "../db/schema";

export type RideRow = typeof rides.$inferSelect;
export type RideRequestRow = typeof rideRequests.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;

/**
 * Ride, request and chat queries live here. Routes enforce who may act; this repository scopes
 * private conversations through participant membership and keeps public rides plate-free.
 */
export function ridesRepo(db: Db) {
  return {
    /** Public browsing joins only a public owner handle; vehiclePlate is intentionally never selected. */
    async listOpen(q: string | undefined, vehicle: string | undefined, now: number) {
      const filters = [eq(rides.status, "open")];
      if (vehicle) filters.push(eq(rides.vehicle, vehicle as RideRow["vehicle"]));
      if (q) {
        const pattern = `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        filters.push(or(like(rides.pickupLabel, pattern), like(rides.destinationLabel, pattern))!);
      }
      const rows = await db
        .select({
          ride: rides,
          ownerName: users.username,
          seatsTaken: sql<number>`coalesce((select sum(${rideRequests.seats}) from ${rideRequests} where ${rideRequests.rideId} = ${rides.id} and ${rideRequests.status} = 'accepted'), 0)`,
        })
        .from(rides)
        .innerJoin(users, eq(users.id, rides.ownerId))
        .where(and(...filters))
        .orderBy(asc(rides.departsAt), desc(rides.createdAt))
        .limit(100)
        .all();
      return rows.filter((r) => r.ride.departsAt === null || r.ride.departsAt >= now);
    },
    async findRide(id: number) {
      return (
        (await db
          .select({ ride: rides, ownerName: users.username })
          .from(rides)
          .innerJoin(users, eq(users.id, rides.ownerId))
          .where(eq(rides.id, id))
          .get()) ?? null
      );
    },
    async listMine(ownerId: number) {
      const rows = await db
        .select({
          ride: rides,
          ownerName: users.username,
          seatsTaken: sql<number>`coalesce((select sum(${rideRequests.seats}) from ${rideRequests} where ${rideRequests.rideId} = ${rides.id} and ${rideRequests.status} = 'accepted'), 0)`,
        })
        .from(rides)
        .innerJoin(users, eq(users.id, rides.ownerId))
        .where(eq(rides.ownerId, ownerId))
        .orderBy(desc(rides.createdAt), desc(rides.id))
        .limit(100)
        .all();
      return rows;
    },
    async createRide(row: typeof rides.$inferInsert) {
      return db.insert(rides).values(row).returning().get();
    },
    async updateRide(id: number, patch: Partial<RideRow>) {
      return db.update(rides).set(patch).where(eq(rides.id, id)).returning().get() ?? null;
    },
    async requestsForRide(rideId: number) {
      return db
        .select({ request: rideRequests, requesterName: users.username })
        .from(rideRequests)
        .innerJoin(users, eq(users.id, rideRequests.requesterId))
        .where(eq(rideRequests.rideId, rideId))
        .orderBy(desc(rideRequests.createdAt), desc(rideRequests.id))
        .all();
    },
    async conversationIdForRequest(requestId: number) {
      const row = await db.select({ id: conversations.id }).from(conversations)
        .where(eq(conversations.rideRequestId, requestId)).get();
      return row?.id ?? null;
    },
    async findRequest(id: number) {
      return (
        (await db.select().from(rideRequests).where(eq(rideRequests.id, id)).get()) ?? null
      );
    },
    async findActiveRequest(rideId: number, requesterId: number) {
      return (
        (await db
          .select()
          .from(rideRequests)
          .where(
            and(
              eq(rideRequests.rideId, rideId),
              eq(rideRequests.requesterId, requesterId),
              inArray(rideRequests.status, ["pending", "accepted"]),
            ),
          )
          .get()) ?? null
      );
    },
    async createRequest(row: typeof rideRequests.$inferInsert) {
      return db.insert(rideRequests).values(row).returning().get();
    },
    /** Passenger view includes the linked public ride, never its plate. */
    async listRequestsByPassenger(requesterId: number) {
      return db
        .select({ request: rideRequests, ride: rides, ownerName: users.username })
        .from(rideRequests)
        .innerJoin(rides, eq(rides.id, rideRequests.rideId))
        .innerJoin(users, eq(users.id, rides.ownerId))
        .where(eq(rideRequests.requesterId, requesterId))
        .orderBy(desc(rideRequests.createdAt), desc(rideRequests.id))
        .limit(100)
        .all();
    },
    /**
     * Set the driver's plate before accepting anyone, so simultaneous accepts cannot disagree
     * about the vehicle. The plate remains private in this table and is exposed only to chat members.
     */
    async reservePlate(rideId: number, plate: string, now: number): Promise<boolean> {
      const row = await db
        .update(rides)
        .set({ vehiclePlate: plate, updatedAt: now })
        .where(
          and(
            eq(rides.id, rideId),
            eq(rides.status, "open"),
            or(isNull(rides.vehiclePlate), eq(rides.vehiclePlate, plate)),
          ),
        )
        .returning({ id: rides.id })
        .get();
      return Boolean(row);
    },
    /**
     * One guarded UPDATE performs both the pending-state transition and seat-capacity check. This
     * prevents two drivers' parallel clicks (or duplicate requests) from reserving the same seats.
     */
    async acceptRequest(id: number, now: number): Promise<RideRequestRow | null> {
      const row = await db
        .update(rideRequests)
        .set({ status: "accepted", decidedAt: now })
        .where(
          and(
            eq(rideRequests.id, id),
            eq(rideRequests.status, "pending"),
            sql`(select status from ${rides} where ${rides.id} = ${rideRequests.rideId}) = 'open'`,
            sql`(select coalesce(sum(accepted.seats), 0) from ride_requests accepted where accepted.ride_id = ${rideRequests.rideId} and accepted.status = 'accepted') + ${rideRequests.seats} <= (select ${rides.totalSeats} from ${rides} where ${rides.id} = ${rideRequests.rideId})`,
          ),
        )
        .returning()
        .get();
      return row ?? null;
    },
    async declineRequest(id: number, now: number): Promise<RideRequestRow | null> {
      const row = await db
        .update(rideRequests)
        .set({ status: "declined", decidedAt: now })
        .where(and(eq(rideRequests.id, id), eq(rideRequests.status, "pending")))
        .returning()
        .get();
      return row ?? null;
    },
    async cancelRequest(id: number, requesterId: number, now: number): Promise<RideRequestRow | null> {
      const row = await db
        .update(rideRequests)
        .set({ status: "cancelled", decidedAt: now })
        .where(
          and(
            eq(rideRequests.id, id),
            eq(rideRequests.requesterId, requesterId),
            inArray(rideRequests.status, ["pending", "accepted"]),
          ),
        )
        .returning()
        .get();
      if (row?.status === "accepted") {
        await db
          .update(conversations)
          .set({ archivedAt: now, updatedAt: now })
          .where(eq(conversations.rideRequestId, id));
      }
      return row ?? null;
    },
    async finishRide(rideId: number, ownerId: number, now: number): Promise<boolean> {
      const changed = await db
        .update(rides)
        .set({ status: "completed", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(rides.id, rideId),
            eq(rides.ownerId, ownerId),
            inArray(rides.status, ["open", "closed"]),
          ),
        )
        .returning({ id: rides.id })
        .get();
      if (!changed) return false;
      const acceptedRequests = db
        .select({ id: rideRequests.id })
        .from(rideRequests)
        .where(and(eq(rideRequests.rideId, rideId), eq(rideRequests.status, "accepted")));
      await db
        .update(conversations)
        .set({ archivedAt: now, updatedAt: now })
        .where(inArray(conversations.rideRequestId, acceptedRequests));
      return true;
    },
    /** Create the conversation and both access-control participant rows after seat acceptance. */
    async createRideConversation(request: RideRequestRow, ownerId: number, now: number) {
      const existing = await db
        .select()
        .from(conversations)
        .where(eq(conversations.rideRequestId, request.id))
        .get();
      if (existing) return existing;
      const conversation = await db
        .insert(conversations)
        .values({ kind: "ride", rideRequestId: request.id, createdAt: now, updatedAt: now })
        .returning()
        .get();
      await db.batch([
        db.insert(conversationParticipants).values([
          { conversationId: conversation.id, userId: ownerId, joinedAt: now },
          { conversationId: conversation.id, userId: request.requesterId, joinedAt: now },
        ]),
        db.insert(chatMessages).values({
          conversationId: conversation.id,
          senderId: ownerId,
          body: "Ride request accepted. You can coordinate the trip here.",
          createdAt: now,
        }),
      ]);
      return conversation;
    },
    async conversationForUser(id: number, userId: number) {
      return (
        (await db
          .select({ conversation: conversations, participant: conversationParticipants })
          .from(conversationParticipants)
          .innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
          .where(
            and(
              eq(conversationParticipants.conversationId, id),
              eq(conversationParticipants.userId, userId),
            ),
          )
          .get()) ?? null
      );
    },
    async listConversationsForUser(userId: number) {
      const mine = await db
        .select({ conversation: conversations, participant: conversationParticipants })
        .from(conversationParticipants)
        .innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
        .where(eq(conversationParticipants.userId, userId))
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(100)
        .all();
      const summaries = [];
      for (const row of mine) {
        const other = await db
          .select({ userId: users.id, username: users.username })
          .from(conversationParticipants)
          .innerJoin(users, eq(users.id, conversationParticipants.userId))
          .where(
            and(
              eq(conversationParticipants.conversationId, row.conversation.id),
              sql`${conversationParticipants.userId} <> ${userId}`,
            ),
          )
          .get();
        if (!other) continue;
        const latest = await db
          .select({ body: chatMessages.body })
          .from(chatMessages)
          .where(eq(chatMessages.conversationId, row.conversation.id))
          .orderBy(desc(chatMessages.id))
          .get();
        const unread = await db
          .select({ n: count() })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.conversationId, row.conversation.id),
              sql`${chatMessages.senderId} <> ${userId}`,
              row.participant.lastReadAt === null
                ? undefined
                : gt(chatMessages.createdAt, row.participant.lastReadAt),
            ),
          )
          .get();
        const rideRequest = row.conversation.rideRequestId
          ? await db
              .select({ request: rideRequests, ride: rides })
              .from(rideRequests)
              .innerJoin(rides, eq(rides.id, rideRequests.rideId))
              .where(eq(rideRequests.id, row.conversation.rideRequestId))
              .get()
          : null;
        summaries.push({
          conversation: row.conversation,
          otherUserId: other.userId,
          otherUserName: other.username,
          lastMessage: latest?.body ?? null,
          unreadCount: unread?.n ?? 0,
          rideRequest: rideRequest?.request ?? null,
          ride: rideRequest?.ride ?? null,
        });
      }
      return summaries;
    },
    async listMessages(conversationId: number) {
      return db
        .select({ message: chatMessages, senderName: users.username })
        .from(chatMessages)
        .innerJoin(users, eq(users.id, chatMessages.senderId))
        .where(eq(chatMessages.conversationId, conversationId))
        .orderBy(desc(chatMessages.id))
        .limit(100)
        .all()
        .then((rows) => rows.reverse());
    },
    async createMessage(row: typeof chatMessages.$inferInsert) {
      // Keep the insert result directly typed; the conversation timestamp is a separate projection.
      const message = await db.insert(chatMessages).values(row).returning().get();
      await db.update(conversations).set({ updatedAt: row.createdAt }).where(eq(conversations.id, row.conversationId));
      return message;
    },
    async participantIds(conversationId: number) {
      const rows = await db
        .select({ userId: conversationParticipants.userId })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.conversationId, conversationId))
        .all();
      return rows.map((row) => row.userId);
    },
    async markConversationRead(conversationId: number, userId: number, now: number) {
      const row = await db
        .update(conversationParticipants)
        .set({ lastReadAt: now })
        .where(
          and(
            eq(conversationParticipants.conversationId, conversationId),
            eq(conversationParticipants.userId, userId),
          ),
        )
        .returning({ userId: conversationParticipants.userId })
        .get();
      return Boolean(row);
    },
  };
}
