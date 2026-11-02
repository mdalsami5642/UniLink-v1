import { and, asc, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, resourceRequests, resourceSubmissions, users } from "../db/schema";

export type ResourceRequestRow = typeof resourceRequests.$inferSelect;
export type ResourceSubmissionRow = typeof resourceSubmissions.$inferSelect;

/** D1 wraps some SQLite errors, so walk the cause chain before deciding a duplicate is a conflict. */
function isDuplicateSubmission(err: unknown): boolean {
  for (let current: unknown = err; current instanceof Error; current = current.cause) {
    if (
      current.message.includes("resource_submissions.request_id, resource_submissions.submitter_id")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resource persistence. Keeping every query here makes the feature route responsible for policy
 * (who may act) and notifications, while this module owns the database flow and joins.
 */
export function resourcesRepo(db: Db) {
  return {
    /** Current, visible dashboard cards. Expired requests are excluded even if a cleanup job has not run. */
    async listOpen(now: number) {
      return db
        .select({ request: resourceRequests, requesterName: users.username })
        .from(resourceRequests)
        .innerJoin(users, eq(users.id, resourceRequests.requesterId))
        .where(and(eq(resourceRequests.status, "open"), gt(resourceRequests.expiresAt, now)))
        .orderBy(desc(resourceRequests.createdAt))
        .all();
    },
    /** Requests made by one user; submissions are fetched separately to avoid leaking them in the feed. */
    async listMine(ownerId: number) {
      return db
        .select()
        .from(resourceRequests)
        .where(eq(resourceRequests.requesterId, ownerId))
        .orderBy(desc(resourceRequests.createdAt))
        .all();
    },
    /** Requester-only view of the links they need to review. */
    async listSubmissions(requestId: number) {
      return db
        .select({ submission: resourceSubmissions, submitterName: users.username })
        .from(resourceSubmissions)
        .innerJoin(users, eq(users.id, resourceSubmissions.submitterId))
        .where(eq(resourceSubmissions.requestId, requestId))
        .orderBy(asc(resourceSubmissions.createdAt), asc(resourceSubmissions.id))
        .all();
    },
    /** Counts and the signed-in user's submission marker decorate public request cards. */
    async submissionSummary(requestIds: number[], viewerId: number) {
      if (requestIds.length === 0) return new Map<number, { count: number; submitted: boolean }>();
      const grouped = await db
        .select({ requestId: resourceSubmissions.requestId, count: count() })
        .from(resourceSubmissions)
        .where(inArray(resourceSubmissions.requestId, requestIds))
        .groupBy(resourceSubmissions.requestId)
        .all();
      const mine = await db
        .select({ requestId: resourceSubmissions.requestId })
        .from(resourceSubmissions)
        .where(
          and(
            inArray(resourceSubmissions.requestId, requestIds),
            eq(resourceSubmissions.submitterId, viewerId),
          ),
        )
        .all();
      const submitted = new Set(mine.map((row) => row.requestId));
      const counts = new Map(grouped.map((row) => [row.requestId, row.count]));
      return new Map(
        requestIds.map((id) => [id, { count: counts.get(id) ?? 0, submitted: submitted.has(id) }]),
      );
    },
    async create(row: Omit<typeof resourceRequests.$inferInsert, "id">) {
      return db.insert(resourceRequests).values(row).returning().get();
    },
    async findRequest(id: number) {
      return (
        (await db.select().from(resourceRequests).where(eq(resourceRequests.id, id)).get()) ?? null
      );
    },
    async createSubmission(row: Omit<typeof resourceSubmissions.$inferInsert, "id">) {
      try {
        return await db.insert(resourceSubmissions).values(row).returning().get();
      } catch (err) {
        if (isDuplicateSubmission(err)) return null;
        throw err;
      }
    },
    /** Submission detail for the owner checks in the route layer. */
    async findSubmission(id: number) {
      return (
        (await db.select().from(resourceSubmissions).where(eq(resourceSubmissions.id, id)).get()) ??
        null
      );
    },
    /** Only an active student with a passing attempt may contribute for this course. */
    async canShareCourseResource(userId: number, courseCode: string): Promise<boolean> {
      const row = await db
        .select({ id: attempts.id })
        .from(attempts)
        .innerJoin(users, eq(users.id, attempts.userId))
        .where(
          and(
            eq(attempts.userId, userId),
            eq(attempts.courseCode, courseCode),
            eq(users.role, "student"),
            eq(users.mustChangePassword, false),
            isNull(users.bannedAt),
            sql`${attempts.grade} not in ('F', 'I', 'W')`,
          ),
        )
        .get();
      return row !== undefined;
    },
    /** Notify only students with a passing attempt for this course; requester is omitted. */
    async courseTakers(courseCode: string, exceptUserId: number): Promise<number[]> {
      const rows = await db
        .selectDistinct({ userId: attempts.userId })
        .from(attempts)
        .innerJoin(users, eq(users.id, attempts.userId))
        .where(
          and(
            eq(attempts.courseCode, courseCode),
            eq(users.role, "student"),
            eq(users.mustChangePassword, false),
            isNull(users.bannedAt),
            sql`${attempts.grade} not in ('F', 'I', 'W')`,
            sql`${attempts.userId} <> ${exceptUserId}`,
          ),
        )
        .all();
      return rows.map((row) => row.userId);
    },
    /** A request can be fulfilled once; this guarded update prevents concurrent accepts from both winning. */
    async fulfill(requestId: number, requesterId: number, submissionId: number) {
      const changed = await db
        .update(resourceRequests)
        .set({ status: "fulfilled" })
        .where(
          and(
            eq(resourceRequests.id, requestId),
            eq(resourceRequests.requesterId, requesterId),
            eq(resourceRequests.status, "open"),
          ),
        )
        .returning({ id: resourceRequests.id })
        .get();
      if (!changed) return false;
      await db
        .update(resourceSubmissions)
        .set({ status: "accepted" })
        .where(
          and(
            eq(resourceSubmissions.id, submissionId),
            eq(resourceSubmissions.requestId, requestId),
            eq(resourceSubmissions.status, "pending"),
          ),
        );
      await db
        .update(resourceSubmissions)
        .set({ status: "rejected" })
        .where(
          and(
            eq(resourceSubmissions.requestId, requestId),
            eq(resourceSubmissions.status, "pending"),
            sql`${resourceSubmissions.id} <> ${submissionId}`,
          ),
        );
      return true;
    },
    /** Rejection only changes a pending submission belonging to a request owned by the caller. */
    async reject(submissionId: number, requestId: number) {
      const rows = await db
        .update(resourceSubmissions)
        .set({ status: "rejected" })
        .where(
          and(
            eq(resourceSubmissions.id, submissionId),
            eq(resourceSubmissions.requestId, requestId),
            eq(resourceSubmissions.status, "pending"),
          ),
        )
        .returning({ id: resourceSubmissions.id });
      return rows.length > 0;
    },
    async close(requestId: number, requesterId: number) {
      const rows = await db
        .update(resourceRequests)
        .set({ status: "closed" })
        .where(
          and(
            eq(resourceRequests.id, requestId),
            eq(resourceRequests.requesterId, requesterId),
            eq(resourceRequests.status, "open"),
          ),
        )
        .returning({ id: resourceRequests.id });
      return rows.length > 0;
    },
  };
}
