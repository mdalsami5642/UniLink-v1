import { z } from "zod";
import { id, instant } from "./common";
import { courseCodeInput } from "./courses";

// Resource sharing is course-only: faculty requests are deliberately not part of this feature.
// These shared schemas are used at both the Hono boundary and the React form/API boundary.

export const resourceRequestInput = z
  .strictObject({
    courseCode: courseCodeInput,
    expiresAt: instant.optional(),
  })
  .refine((r) => r.expiresAt === undefined || r.expiresAt > Date.now(), {
    path: ["expiresAt"],
    message: "Choose an expiry time in the future",
  });

/** Allow only HTTPS Google Drive/Docs links; a general URL parser would permit arbitrary destinations. */
export const googleDriveUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["drive.google.com", "docs.google.com"].includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}, "Use an HTTPS Google Drive or Google Docs link");

export const resourceSubmissionInput = z.strictObject({
  url: googleDriveUrl,
});

export const resourceRequestStatus = z.enum(["open", "fulfilled", "closed"]);
export const resourceSubmissionStatus = z.enum(["pending", "accepted", "rejected"]);

export const resourceRequest = z.object({
  id,
  requesterId: id,
  requesterName: z.string(),
  courseCode: courseCodeInput,
  status: resourceRequestStatus,
  expiresAt: instant,
  createdAt: instant,
  submissionCount: z.number().int().nonnegative(),
  hasSubmitted: z.boolean(),
});

export const resourceSubmission = z.object({
  id,
  requestId: id,
  submitterId: id,
  submitterName: z.string(),
  url: googleDriveUrl,
  status: resourceSubmissionStatus,
  createdAt: instant,
});

export const resourceRequestPage = z.object({
  items: z.array(resourceRequest),
});

export const myResourceRequest = resourceRequest.extend({
  submissions: z.array(resourceSubmission),
});

export const myResourceRequests = z.object({ items: z.array(myResourceRequest) });

export const resourceOk = z.object({ ok: z.boolean() });
