import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import {
  myResourceRequestsQuery,
  resourceDashboardQuery,
  useCloseResourceRequest,
  useCreateResourceRequest,
  useResourceDecision,
  useSubmitResourceLink,
} from "@/lib/resources";
import { toast } from "@/lib/toast";
import { attemptsQuery, courseMapQuery, meQuery } from "@/lib/queries";
import { useNow } from "@/lib/useNow";
import { isPassingGrade } from "../../shared/grading";
import type { z } from "zod";
import type { resourceRequest, myResourceRequest } from "../../shared/schemas/resources";

export const Route = createFileRoute("/resources")({
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(meQuery).catch(() => null))) {
      throw redirect({ to: "/login" });
    }
  },
  component: ResourcesPage,
});

const panel = "rounded-panel border border-line bg-surface p-5";
const label = "mb-1 block text-sm font-medium text-ink";

/**
 * The dashboard composes two server views: a public list of open requests and a private list of
 * this user's requests/submissions. Links never come from the public feed response.
 */
function ResourcesPage() {
  const dashboard = useQuery(resourceDashboardQuery);
  const mine = useQuery(myResourceRequestsQuery);
  const attempts = useQuery(attemptsQuery);
  const courseMap = useQuery(courseMapQuery);
  const create = useCreateResourceRequest();
  const now = useNow();
  const [courseCode, setCourseCode] = useState("");
  // The same passing-grade rule that marks a course completed on the map gates resource sharing.
  const completedCodes = [
    ...new Set(
      (attempts.data ?? [])
        .filter((attempt) => isPassingGrade(attempt.grade))
        .map((attempt) => attempt.courseCode),
    ),
  ].sort();
  const courseTitles = new Map<string, string>();
  for (const category of courseMap.data?.categories ?? []) {
    for (const slot of category.slots) {
      if (slot.kind === "course") {
        courseTitles.set(slot.code, slot.title);
        for (const alternative of slot.alternatives) {
          courseTitles.set(alternative.code, alternative.title);
        }
      }
      if (slot.studentCourse) courseTitles.set(slot.studentCourse.code, slot.studentCourse.title);
    }
    for (const trail of category.trails?.trails ?? []) {
      for (const course of trail.courses) courseTitles.set(course.code, course.title);
    }
  }
  for (const course of courseMap.data?.extras ?? []) courseTitles.set(course.code, course.title);

  function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate(
      { courseCode },
      {
        onSuccess: () => {
          setCourseCode("");
          toast.success("Your request is on the dashboard.");
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-ink">Resource sharing</h1>
        <p className="text-sm text-soft">
          Ask for notes or study materials by course, or share a Google Drive link with another
          student.
        </p>
      </header>

      <section className={panel} aria-labelledby="new-request-title">
        <h2 id="new-request-title" className="font-semibold text-ink">
          Request a resource
        </h2>
        <p className="mt-1 text-sm text-soft">
          Students who passed the course will receive an inbox notification and, if enabled, a push
          notification.
        </p>
        <form className="mt-4 space-y-4" onSubmit={submitRequest}>
          <div>
            <label className={label} htmlFor="resource-course">
              Course code
            </label>
            <Input
              id="resource-course"
              required
              maxLength={8}
              autoCapitalize="characters"
              placeholder="e.g. CSE115"
              value={courseCode}
              onChange={(event) => setCourseCode(event.target.value.toUpperCase())}
            />
          </div>
          <Button type="submit" disabled={create.isPending || !courseCode.trim()}>
            {create.isPending ? "Posting…" : "Post request"}
          </Button>
        </form>
      </section>

      <section className={panel} aria-labelledby="shareable-courses-title">
        <h2 id="shareable-courses-title" className="font-semibold text-ink">
          Courses you can share
        </h2>
        <p className="mt-1 text-sm text-soft">
          Share a Google Drive link when someone requests resources for a course you completed.
        </p>
        {attempts.isPending ? (
          <p className="mt-3 text-sm text-soft">Loading your completed courses…</p>
        ) : attempts.isError ? (
          <p className="mt-3 text-sm text-soft" role="status">
            Your completed courses could not be checked.
          </p>
        ) : completedCodes.length === 0 ? (
          <p className="mt-3 text-sm text-soft">
            Record a passing grade on the Courses page to become eligible to share.
          </p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {completedCodes.map((code) => (
              <li key={code} className="rounded-control bg-tint px-3 py-2 text-sm text-ink">
                <span className="font-medium">{code}</span>
                {courseTitles.has(code) ? (
                  <span className="text-soft"> · {courseTitles.get(code)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="requests-title">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="requests-title" className="text-lg font-semibold text-ink">
            Open requests
          </h2>
          <Button variant="outline" size="sm" onClick={() => void dashboard.refetch()}>
            Refresh
          </Button>
        </div>
        {dashboard.isPending ? <p className="text-sm text-soft">Loading requests…</p> : null}
        {dashboard.isError ? (
          <div className={`${panel} text-sm`}>
            <p className="text-ink">The request dashboard didn’t load.</p>
            <p className="mt-1 text-soft">{errorMessage(dashboard.error)}</p>
          </div>
        ) : null}
        {dashboard.data?.items.length === 0 ? (
          <div className={`${panel} text-center text-sm text-soft`}>No open requests yet.</div>
        ) : null}
        <ul className="space-y-3">
          {dashboard.data?.items.map((request) => (
            <li key={request.id}>
              <RequestCard
                request={request}
                own={mine.data?.items.some((r) => r.id === request.id) ?? false}
                eligibilityPending={attempts.isPending}
                eligible={completedCodes.includes(request.courseCode)}
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3" aria-labelledby="mine-title">
        <h2 id="mine-title" className="text-lg font-semibold text-ink">
          Your requests
        </h2>
        {mine.isPending ? <p className="text-sm text-soft">Loading your requests…</p> : null}
        {mine.isError ? <p className="text-sm text-soft">{errorMessage(mine.error)}</p> : null}
        {mine.data?.items.length === 0 ? (
          <div className={`${panel} text-sm text-soft`}>
            Requests you post and their submitted links will appear here.
          </div>
        ) : null}
        <ul className="space-y-3">
          {mine.data?.items.map((request) => (
            <li key={request.id}>
              <OwnedRequest request={request} now={now} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** A public card contains counts and a submit action, never another user's pending Drive link. */
function RequestCard({
  request,
  own,
  eligibilityPending,
  eligible,
}: {
  request: z.infer<typeof resourceRequest>;
  own: boolean;
  eligibilityPending: boolean;
  eligible: boolean;
}) {
  const submit = useSubmitResourceLink(request.id);
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState("");

  function submitLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit.mutate(
      { url },
      {
        onSuccess: () => {
          setUrl("");
          setShowForm(false);
          toast.success("Your link was sent to the requester.");
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  }

  return (
    <article className={panel}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-ink">{request.courseCode}</h3>
          <p className="text-sm text-soft">Requested by {request.requesterName}</p>
        </div>
        <span className="text-xs text-soft">
          {request.submissionCount} link{request.submissionCount === 1 ? "" : "s"} sent
        </span>
      </div>
      <p className="mt-2 text-xs text-faint">
        Expires {new Date(request.expiresAt).toLocaleDateString()}
      </p>
      {own ? (
        <p className="mt-3 text-sm text-soft">This is your request. Review links below.</p>
      ) : request.hasSubmitted ? (
        <p className="mt-3 text-sm text-soft">You already sent a link for this request.</p>
      ) : eligibilityPending ? (
        <p className="mt-3 text-sm text-soft">Checking your completed courses…</p>
      ) : !eligible ? (
        <p className="mt-3 text-sm text-soft">
          Only students who passed {request.courseCode} can share a resource here.
        </p>
      ) : (
        <div className="mt-4">
          {showForm ? (
            <form className="space-y-3" onSubmit={submitLink}>
              <div>
                <label className={label} htmlFor={`drive-url-${request.id}`}>
                  Google Drive link
                </label>
                <Input
                  id={`drive-url-${request.id}`}
                  type="url"
                  required
                  placeholder="https://drive.google.com/..."
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={submit.isPending}>
                  {submit.isPending ? "Sending…" : "Send link"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button onClick={() => setShowForm(true)}>Share a link</Button>
          )}
        </div>
      )}
    </article>
  );
}

/** The owner's private panel displays submissions and owns accept/reject/close actions. */
function OwnedRequest({
  request,
  now,
}: {
  request: z.infer<typeof myResourceRequest>;
  now: number;
}) {
  const accept = useResourceDecision("accept");
  const reject = useResourceDecision("reject");
  const close = useCloseResourceRequest();
  const expired = request.status === "open" && request.expiresAt <= now;
  const status = expired ? "expired" : request.status;

  return (
    <article className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-ink">{request.courseCode}</h3>
        <span className="text-xs capitalize text-soft">{status}</span>
      </div>
      {request.submissions.length === 0 ? (
        <p className="mt-3 text-sm text-soft">No links submitted yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {request.submissions.map((submission) => (
            <li key={submission.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <p className="text-sm text-soft">
                From {submission.submitterName} ·{" "}
                <span className="capitalize">{submission.status}</span>
              </p>
              <a
                href={submission.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-sm text-brand underline"
              >
                Open Google Drive link
              </a>
              {request.status === "open" && !expired && submission.status === "pending" ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={accept.isPending || reject.isPending}
                    onClick={() =>
                      accept.mutate(submission.id, {
                        onSuccess: () => toast.success("Link accepted."),
                        onError: (error) => toast.error(errorMessage(error)),
                      })
                    }
                  >
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={accept.isPending || reject.isPending}
                    onClick={() =>
                      reject.mutate(submission.id, {
                        onSuccess: () => toast.success("Link rejected."),
                        onError: (error) => toast.error(errorMessage(error)),
                      })
                    }
                  >
                    Reject
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {request.status === "open" && !expired ? (
        <Button
          className="mt-4"
          variant="outline"
          size="sm"
          disabled={close.isPending}
          onClick={() =>
            close.mutate(request.id, {
              onSuccess: () => toast.success("Request closed."),
              onError: (error) => toast.error(errorMessage(error)),
            })
          }
        >
          Close request
        </Button>
      ) : null}
    </article>
  );
}
