import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { chatMessageInput } from "../../../shared/schemas/rides";
import { pushSenderFromEnv } from "../../adapters/push";
import { getDb } from "../../db/client";
import { requireUser } from "../../middleware/auth";
import type { AppEnv } from "../../middleware/types";
import { rideRequests, rides } from "../../db/schema";
import { notify } from "../../notify";
import { ridesRepo } from "../../repos/rides";
import { validateJson } from "../../validate";

const uid = (c: Context<AppEnv>) => c.get("user")?.id ?? 0;
const validId = (c: Context) => { const id = Number(c.req.param("id")); return Number.isSafeInteger(id) && id > 0 ? id : null; };

/** Inbox is a separate chat product surface. Every read/write checks participant membership. */
export const chatRoutes = new Hono<AppEnv>().use(requireUser)
  .get("/conversations", async (c) => {
    const repo = ridesRepo(getDb(c.env.DB)); const rows = await repo.listConversationsForUser(uid(c));
    const items = rows.map((row: any) => ({
      id: row.conversation.id, kind: row.conversation.kind,
      title: row.ride ? `${row.ride.pickupLabel} → ${row.ride.destinationLabel}` : row.otherUserName,
      otherUserId: row.otherUserId, otherUserName: row.otherUserName,
      rideId: row.ride?.id ?? null, rideRequestId: row.conversation.rideRequestId,
      rideStatus: row.ride?.status ?? null, archivedAt: row.conversation.archivedAt,
      unreadCount: row.unreadCount, lastMessage: row.lastMessage, updatedAt: row.conversation.updatedAt,
    }));
    return c.json({ items });
  })
  .get("/conversations/:id/messages", async (c) => {
    const id = validId(c); if (!id) return c.json({ error: "not_found" }, 404);
    const db = getDb(c.env.DB); const repo = ridesRepo(db);
    const access = await repo.conversationForUser(id, uid(c)); if (!access) return c.json({ error: "not_found" }, 404);
    await repo.markConversationRead(id, uid(c), Date.now());
    const items = await repo.listMessages(id);
    const plate = access.conversation.rideRequestId
      ? await db.select({ plate: rides.vehiclePlate }).from(rides)
          .innerJoin(rideRequests, eq(rides.id, rideRequests.rideId))
          .where(eq(rideRequests.id, access.conversation.rideRequestId)).get()
      : null;
    return c.json({ items: items.map((row) => ({
      id: row.message.id, conversationId: row.message.conversationId, senderId: row.message.senderId,
      senderName: row.senderName, body: row.message.body, createdAt: row.message.createdAt,
    })), vehiclePlate: plate?.plate ?? null });
  })
  .post("/conversations/:id/messages", validateJson(chatMessageInput), async (c) => {
    const id = validId(c); if (!id) return c.json({ error: "not_found" }, 404);
    const db = getDb(c.env.DB); const repo = ridesRepo(db); const access = await repo.conversationForUser(id, uid(c));
    if (!access) return c.json({ error: "not_found" }, 404);
    if (access.conversation.archivedAt !== null) return c.json({ error: "conversation_archived", message: "This ride chat is archived." }, 409);
    const now = Date.now(); const body = c.req.valid("json");
    const row = await repo.createMessage({ conversationId: id, senderId: uid(c), body: body.body, createdAt: now });
    const recipients = (await repo.participantIds(id)).filter((x) => x !== uid(c));
    await notify(db, recipients, "chat_message", { conversationId: id }, { now, push: pushSenderFromEnv(c.env) });
    return c.json({ id: row.id, conversationId: id, senderId: uid(c), senderName: c.get("user")!.username, body: row.body, createdAt: now }, 201);
  });
