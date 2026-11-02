import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import {
  myResourceRequests,
  resourceOk,
  resourceRequestInput,
  resourceRequestPage,
  resourceSubmissionInput,
  type myResourceRequest,
  type resourceRequest,
  type resourceSubmission,
} from "../../../shared/schemas/resources";
import { pushSenderFromEnv } from "../../adapters/push";
import { getDb } from "../../db/client";
import { users } from "../../db/schema";
import { limits } from "../../limits";
import { requireUser } from "../../middleware/auth";
import type { AppEnv } from "../../middleware/types";
import { notify } from "../../notify";
import { rateLimit, rateLimitedResponse } from "../../middleware/rateLimit";
import { curriculaRepo } from "../../repos/curricula";
import { resourcesRepo } from "../../repos/resources";
import { studentCoursesRepo } from "../../repos/studentCourses";
import { validateJson } from "../../validate";

const userId = (c: Context<AppEnv>) => c.get("user")?.id ?? 0;
const notFound = (c: Context) => c.json({ error: "not_found" }, 404);
const badState = (c: Context, message: string) => c.json({ error: "invalid_state", message }, 409);

function paramId(c: Context): number | null {
  const value = Number(c.req.param("id"));
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** One shared per-user write budget covers request creation, submissions, and decisions. */
async function writeLimited(c: Context<AppEnv>, db: ReturnType<typeof getDb>) {
  const hit = await rateLimit(
    db,
    `resources:user:${userId(c)}`,
    limits.resourceWrites.limit,
    limits.resourceWrites.windowMs,
  );
  return hit.allowed ? null : rateLimitedResponse(c, hit);
}

/** Serialize database rows into the public dashboard contract, including viewer-specific flags. */
function toRequest(
  row: Awaited<ReturnType<ReturnType<typeof resourcesRepo>["listOpen"]>>[number],
  summary: { count: number; submitted: boolean },
) {
  return {
    id: row.request.id,
    requesterId: row.request.requesterId,
    requesterName: row.requesterName,
    courseCode: row.request.courseCode,
    status: row.request.status,
    expiresAt: row.request.expiresAt,
    createdAt: row.request.createdAt,
    submissionCount: summary.count,
    hasSubmitted: summary.submitted,
  } satisfies z.infer<typeof resourceRequest>;
}

function toSubmission(
  row: Awaited<ReturnType<ReturnType<typeof resourcesRepo>["listSubmissions"]>>[number],
) {
  return {
    id: row.submission.id,
    requestId: row.submission.requestId,
    submitterId: row.submission.submitterId,
    submitterName: row.submitterName,
    url: row.submission.url,
    status: row.submission.status,
    createdAt: row.submission.createdAt,
  } satisfies z.infer<typeof resourceSubmission>;
}

/**
 * Resource API boundary: authentication and ownership are checked here; repositories perform SQL;
 * `notify()` persists inbox rows and fans out best-effort pushes. The browser never supplies recipient IDs.
 */
export const resourceRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/requests", async (c) => {
    const db = getDb(c.env.DB);
    const repo = resourcesRepo(db);
    const rows = await repo.listOpen(Date.now());
    const summaries = await repo.submissionSummary(
      rows.map((row) => row.request.id),
      userId(c),
    );
    const items = rows.map((row) =>
      toRequest(row, summaries.get(row.request.id) ?? { count: 0, submitted: false }),
    );
    return c.json({ items } satisfies z.infer<typeof resourceRequestPage>);
  })
  .get("/requests/mine", async (c) => {
    const db = getDb(c.env.DB);
    const repo = resourcesRepo(db);
    const owner = userId(c);
    const [requests, requester] = await Promise.all([
      repo.listMine(owner),
      db.select({ name: users.username }).from(users).where(eq(users.id, owner)).get(),
    ]);
    const items: z.infer<typeof myResourceRequest>[] = [];
    for (const request of requests) {
      const submissions = await repo.listSubmissions(request.id);
      const summary = await repo.submissionSummary([request.id], owner);
      items.push({
        id: request.id,
        requesterId: owner,
        requesterName: requester?.name ?? "student",
        courseCode: request.courseCode,
        status: request.status,
        expiresAt: request.expiresAt,
        createdAt: request.createdAt,
        submissionCount: summary.get(request.id)?.count ?? 0,
        hasSubmitted: false,
        submissions: submissions.map(toSubmission),
      });
    }
    return c.json({ items } satisfies z.infer<typeof myResourceRequests>);
  })
  .post("/requests", validateJson(resourceRequestInput), async (c) => {
    const db = getDb(c.env.DB);
    const limited = await writeLimited(c, db);
    if (limited) return limited;
    const body = c.req.valid("json");
    const now = Date.now();
    // A syntactically valid code is not necessarily a real NSU course; accept imported courses or a course the requester added.
    const [catalogCourse, ownCourses] = await Promise.all([
      curriculaRepo(db).lookupByCode(body.courseCode, null),
      studentCoursesRepo(db, userId(c)).listOwn(),
    ]);
    if (!catalogCourse && !ownCourses.some((course) => course.code === body.courseCode)) {
      return c.json(
        { error: "unknown_course", message: "Choose a course from the NSU course catalog." },
        400,
      );
    }
    // Server owns the default expiry and caps a caller-supplied expiry to the feature's maximum TTL.
    const expiresAt = Math.min(
      body.expiresAt ?? now + limits.resourceRequestTtlMs,
      now + limits.resourceRequestTtlMs,
    );
    const request = await resourcesRepo(db).create({
      requesterId: userId(c),
      courseCode: body.courseCode,
      status: "open",
      expiresAt,
      createdAt: now,
    });
    // Recipient selection is derived from stored course attempts; clients cannot target arbitrary users.
    const recipients = await resourcesRepo(db).courseTakers(body.courseCode, userId(c));
    await notify(
      db,
      recipients,
      "resource_requested",
      { courseCode: body.courseCode },
      {
        now,
        push: pushSenderFromEnv(c.env),
      },
    );
    const requester = await db
      .select({ name: users.username })
      .from(users)
      .where(eq(users.id, userId(c)))
      .get();
    return c.json(
      {
        id: request.id,
        requesterId: request.requesterId,
        requesterName: requester?.name ?? "student",
        courseCode: request.courseCode,
        status: request.status,
        expiresAt: request.expiresAt,
        createdAt: request.createdAt,
        submissionCount: 0,
        hasSubmitted: false,
      } satisfies z.infer<typeof resourceRequest>,
      201,
    );
  })
  .post("/requests/:id/submissions", validateJson(resourceSubmissionInput), async (c) => {
    const requestId = paramId(c);
    if (requestId === null) return notFound(c);
    const db = getDb(c.env.DB);
    const limited = await writeLimited(c, db);
    if (limited) return limited;
    const repo = resourcesRepo(db);
    const request = await repo.findRequest(requestId);
    if (!request) return notFound(c);
    if (request.requesterId === userId(c)) return c.json({ error: "own_request" }, 400);
    if (request.status !== "open" || request.expiresAt <= Date.now()) {
      return badState(c, "This request is no longer accepting links.");
    }
    // Course completion is checked at the API boundary; hiding the button is not authorization.
    if (!(await repo.canShareCourseResource(userId(c), request.courseCode))) {
      return c.json(
        {
          error: "course_not_completed",
          message: "Only students who passed this course can share a resource.",
        },
        403,
      );
    }
    const body = c.req.valid("json");
    const now = Date.now();
    const submission = await repo.createSubmission({
      requestId,
      submitterId: userId(c),
      url: body.url,
      status: "pending",
      createdAt: now,
    });
    if (!submission) return badState(c, "You already sent a link for this request.");
    // Only the request owner receives the submission alert; the link itself stays out of notification payloads.
    await notify(
      db,
      [request.requesterId],
      "resource_submitted",
      { requestId },
      {
        now,
        push: pushSenderFromEnv(c.env),
      },
    );
    const submitter = await db
      .select({ name: users.username })
      .from(users)
      .where(eq(users.id, userId(c)))
      .get();
    return c.json(
      {
        id: submission.id,
        requestId: submission.requestId,
        submitterId: submission.submitterId,
        submitterName: submitter?.name ?? "student",
        url: submission.url,
        status: submission.status,
        createdAt: submission.createdAt,
      } satisfies z.infer<typeof resourceSubmission>,
      201,
    );
  })
  .post("/submissions/:id/accept", async (c) => {
    const submissionId = paramId(c);
    if (submissionId === null) return notFound(c);
    const db = getDb(c.env.DB);
    const repo = resourcesRepo(db);
    const submission = await repo.findSubmission(submissionId);
    if (!submission) return notFound(c);
    const request = await repo.findRequest(submission.requestId);
    if (!request || request.requesterId !== userId(c)) return notFound(c);
    const limited = await writeLimited(c, db);
    if (limited) return limited;
    if (
      request.status !== "open" ||
      request.expiresAt <= Date.now() ||
      submission.status !== "pending"
    ) {
      return badState(c, "This link or request has already been decided.");
    }
    if (!(await repo.fulfill(request.id, userId(c), submission.id))) {
      return badState(c, "Another action already closed this request.");
    }
    await notify(
      db,
      [submission.submitterId],
      "resource_accepted",
      { requestId: request.id },
      {
        push: pushSenderFromEnv(c.env),
      },
    );
    return c.json({ ok: true } satisfies z.infer<typeof resourceOk>);
  })
  .post("/submissions/:id/reject", async (c) => {
    const submissionId = paramId(c);
    if (submissionId === null) return notFound(c);
    const db = getDb(c.env.DB);
    const repo = resourcesRepo(db);
    const submission = await repo.findSubmission(submissionId);
    if (!submission) return notFound(c);
    const request = await repo.findRequest(submission.requestId);
    if (!request || request.requesterId !== userId(c)) return notFound(c);
    const limited = await writeLimited(c, db);
    if (limited) return limited;
    if (request.status !== "open" || !(await repo.reject(submission.id, request.id))) {
      return badState(c, "This link or request has already been decided.");
    }
    return c.json({ ok: true } satisfies z.infer<typeof resourceOk>);
  })
  .post("/requests/:id/close", async (c) => {
    const requestId = paramId(c);
    if (requestId === null) return notFound(c);
    const db = getDb(c.env.DB);
    const limited = await writeLimited(c, db);
    if (limited) return limited;
    const changed = await resourcesRepo(db).close(requestId, userId(c));
    return changed ? c.json({ ok: true } satisfies z.infer<typeof resourceOk>) : notFound(c);
  });
