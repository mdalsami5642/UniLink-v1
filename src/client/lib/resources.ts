import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  myResourceRequests,
  resourceOk,
  resourceRequest,
  resourceRequestInput,
  resourceRequestPage,
  resourceSubmission,
  resourceSubmissionInput,
} from "../../shared/schemas/resources";
import { apiGet, apiPost } from "./api";

/** Shared keys keep the dashboard and the user's private review list in sync after every action. */
export const resourceDashboardQuery = queryOptions({
  queryKey: ["resources", "dashboard"],
  queryFn: () => apiGet("/api/resources/requests", resourceRequestPage),
});

export const myResourceRequestsQuery = queryOptions({
  queryKey: ["resources", "mine"],
  queryFn: () => apiGet("/api/resources/requests/mine", myResourceRequests),
});

function useRefreshResources() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["resources"] });
}

/** Mutations only talk to the API; the server decides recipients and enforces request ownership. */
export function useCreateResourceRequest() {
  const refresh = useRefreshResources();
  return useMutation({
    mutationFn: (body: z.input<typeof resourceRequestInput>) =>
      apiPost("/api/resources/requests", resourceRequest, body),
    onSuccess: refresh,
  });
}

export function useSubmitResourceLink(requestId: number) {
  const refresh = useRefreshResources();
  return useMutation({
    mutationFn: (body: z.input<typeof resourceSubmissionInput>) =>
      apiPost(`/api/resources/requests/${requestId}/submissions`, resourceSubmission, body),
    onSuccess: refresh,
  });
}

export function useResourceDecision(action: "accept" | "reject") {
  const refresh = useRefreshResources();
  return useMutation({
    mutationFn: (submissionId: number) =>
      apiPost(`/api/resources/submissions/${submissionId}/${action}`, resourceOk),
    onSuccess: refresh,
  });
}

export function useCloseResourceRequest() {
  const refresh = useRefreshResources();
  return useMutation({
    mutationFn: (requestId: number) =>
      apiPost(`/api/resources/requests/${requestId}/close`, resourceOk),
    onSuccess: refresh,
  });
}
