# Resource sharing

The resource-sharing page is `/resources`. It is linked from Home so the phone tab bar can keep its current five destinations.

## Data flow

```text
Resource page
  → src/client/lib/resources.ts (TanStack Query keys and mutations)
  → same-origin /api/resources/* (shared Zod validation)
  → src/server/features/resources/routes.ts (auth, ownership, state checks)
  → src/server/repos/resources.ts (Drizzle queries)
  → D1 resource_requests / resource_submissions
```

When a request is created, the route asks the repository for distinct student IDs with an `attempts` row for the exact course code. The requester is excluded. The route passes those IDs to `notify()`, which writes inbox rows and sends best-effort push through the configured adapter. A resource request notification contains the course code but no requester identity. Push remains optional; an inbox notification is always stored for each selected recipient. The app's existing push fan-out limit applies, so a request with more than 40 recipients may send fewer pushes while still creating every inbox row.

The public feed includes only open, unexpired requests, a submission count and a viewer-specific `hasSubmitted` flag. It does not include submitted URLs. The `/requests/mine` response is scoped to the signed-in requester and includes the links they need to review. The request owner can accept or reject a pending submission, or close their request; accepting one link fulfills the request and rejects its other pending links.

Google Drive links are validated in `src/shared/schemas/resources.ts` on both API input and output. The URL must use HTTPS and the exact host `drive.google.com` or `docs.google.com`. The feature intentionally has no free-text request or submission notes in this first pass. The browser sends request and link data through the shared mutation helpers; it does not choose notification recipients or enforce ownership.

## Files by layer

- `src/shared/schemas/resources.ts`: request, submission, status, URL, and response contracts.
- `src/server/db/schema.ts` and `drizzle/0014_resources.sql`: persisted request/submission records and query indexes.
- `src/server/repos/resources.ts`: all resource SQL, course-taker lookup and state updates.
- `src/server/features/resources/routes.ts`: API validation, auth, authorization, writes and notification orchestration.
- `src/client/lib/resources.ts`: query cache keys and API mutations.
- `src/client/routes/resources.tsx`: request dashboard and private submission review screen.
- `src/client/routes/index.tsx`: Home entry point.

## Current behavior and scope

Each student can submit once per request. A request expires after 14 days by default; its creator can close it sooner. An accepted request is removed from the open dashboard. Direct messages, faculty targeting, file uploads, edits, and resource-specific moderator review are not part of this implementation.
