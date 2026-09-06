/**
 * Webhook CRUD hooks (#638 / #600), scope-parameterized over project | program.
 *
 * The project and program webhook endpoints are identical in shape (ADR-0076):
 * /api/v1/{scope}s/{id}/webhooks/. One hook set serves both the project and
 * program Integrations pages — the scope is passed in, not hard-coded.
 */

import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api';
import type { PaginatedResponse } from '@/api/types';

/** Which scope a webhook/token is managed under. */
export interface IntegrationScope {
  kind: 'project' | 'program';
  id: string;
}

function basePath(scope: IntegrationScope): string {
  // kind is 'project' | 'program' → pluralized path segment.
  return `/${scope.kind}s/${scope.id}/webhooks/`;
}

function webhooksKey(scope: IntegrationScope) {
  return ['webhooks', scope.kind, scope.id] as const;
}

// ---------------------------------------------------------------------------
// API shapes (match WebhookSerializer / WebhookDeliverySerializer)
// ---------------------------------------------------------------------------

export type WebhookDeliveryStatus = 'pending' | 'success' | 'failed';

export interface ApiWebhook {
  id: string;
  project: string | null;
  program: string | null;
  url: string;
  events: string[];
  format: string;
  is_active: boolean;
  /** Whether a signing secret is stored. The secret itself is never readable. */
  secret_set: boolean;
  /**
   * Present ONLY in the 201 create response, which echoes an auto-generated
   * secret exactly once (#893). Absent from every list/retrieve body — do not
   * write code that expects to read it back.
   */
  secret?: string;
  /** Terminal delivery failures since the last success (#2884). */
  consecutive_failures: number;
  last_failure_at: string | null;
  last_failure_reason: string;
  /** Set when the automatic failure guard deactivated the subscription (#2884). */
  disabled_at: string | null;
  disabled_reason: string;
  created_at: string;
  created_by: string | null;
}

export interface ApiWebhookDelivery {
  id: string;
  event_type: string;
  sequence_number: number;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  response_status: number | null;
  attempt_count: number;
  created_at: string;
  completed_at: string | null;
}

/** Fields a client may write. `secret` is write-only (never returned). */
export interface WebhookWriteBody {
  url: string;
  events: string[];
  format: string;
  is_active?: boolean;
  secret?: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** List webhooks for the given scope. */
export function useWebhooks(scope: IntegrationScope | null | undefined) {
  return useQuery<ApiWebhook[], Error>({
    queryKey: scope ? webhooksKey(scope) : ['webhooks', 'none'],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiWebhook>>(basePath(scope!));
      return res.data.results;
    },
    enabled: !!scope?.id,
    retry: false,
  });
}

/** Recent delivery log for one webhook (most recent page, newest first). */
export function useWebhookDeliveries(
  scope: IntegrationScope | null | undefined,
  webhookId: string | null | undefined,
) {
  return useQuery<ApiWebhookDelivery[], Error>({
    queryKey: scope ? [...webhooksKey(scope), webhookId, 'deliveries'] : ['webhooks', 'none'],
    queryFn: async () => {
      // Deliveries are cursor-paginated newest-first (issue 1317). Read the first
      // page only — this is a "recent deliveries" log, so the most recent page
      // is the right view; we intentionally do not page through full history.
      const res = await apiClient.get<PaginatedResponse<ApiWebhookDelivery>>(
        `${basePath(scope!)}${webhookId}/deliveries/`,
      );
      return res.data.results;
    },
    enabled: !!scope?.id && !!webhookId,
  });
}

export function useCreateWebhook(scope: IntegrationScope) {
  const qc = useQueryClient();
  return useMutation<ApiWebhook, Error, WebhookWriteBody>({
    mutationFn: async (body) => {
      const res = await apiClient.post<ApiWebhook>(basePath(scope), body);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: webhooksKey(scope) });
    },
  });
}

export function useUpdateWebhook(scope: IntegrationScope) {
  const qc = useQueryClient();
  return useMutation<ApiWebhook, Error, { id: string; body: Partial<WebhookWriteBody> }>({
    mutationFn: async ({ id, body }) => {
      const res = await apiClient.patch<ApiWebhook>(`${basePath(scope)}${id}/`, body);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: webhooksKey(scope) });
    },
  });
}

export function useDeleteWebhook(scope: IntegrationScope) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      await apiClient.delete(`${basePath(scope)}${id}/`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: webhooksKey(scope) });
    },
  });
}

/**
 * Poll one webhook's delivery log until `deliveryId` reaches a terminal status.
 *
 * The test-ping endpoint answers 202 with a `delivery_id` — it acknowledges the
 * *enqueue*, not the receiver's response. Reporting that 202 as "Sent ✓" is what
 * made the admin's only diagnostic tool claim success on a delivery that was
 * guaranteed to fail (#2884). This hook closes the loop by reading back the real
 * `status` / `response_status` the receiver produced.
 *
 * Polling stops as soon as the row leaves `pending`, and is **bounded** either way.
 * A `pending` row is not a slow read — it means the delivery is still inside the
 * retry chain, whose attempts land at 0/30/90/210/450s. So "poll until terminal"
 * with no deadline means ~450 requests for one click against a slow receiver, and
 * *unbounded* polling when no worker or beat is running (the row then stays
 * `pending` forever). Each request is a full first cursor page — up to 50 delivery
 * rows with their complete payloads — so the cost is not small either.
 *
 * The bound is therefore a real timeout, not a nicety: past `POLL_BUDGET_MS` the
 * caller reports "still pending, check the delivery log" rather than pretending to
 * still be watching. The interval also backs off, because a delivery that has not
 * settled in 5 seconds is in the retry chain and will not settle for 30 more.
 */
const POLL_BUDGET_MS = 45_000;

function testPollInterval(elapsedMs: number): number {
  if (elapsedMs < 5_000) return 1_000;
  if (elapsedMs < 15_000) return 2_000;
  return 5_000;
}

export function useWebhookTestResult(
  scope: IntegrationScope,
  webhookId: string,
  deliveryId: string | null,
) {
  // Reset per delivery id, so a second Test click gets a fresh budget.
  const startedAt = useRef<{ id: string | null; at: number }>({ id: null, at: 0 });
  if (startedAt.current.id !== deliveryId) {
    startedAt.current = { id: deliveryId, at: Date.now() };
  }

  const query = useQuery<ApiWebhookDelivery | null, Error>({
    queryKey: [...webhooksKey(scope), webhookId, 'test-result', deliveryId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiWebhookDelivery>>(
        `${basePath(scope)}${webhookId}/deliveries/`,
      );
      return res.data.results.find((d) => d.id === deliveryId) ?? null;
    },
    enabled: !!deliveryId,
    // `null` (row not on the page yet) keeps polling: the 202 and the first read can
    // race, and giving up immediately would report "no result" for a live delivery.
    refetchInterval: (q) => {
      const row = q.state.data;
      if (row && row.status !== 'pending') return false;
      const elapsed = Date.now() - startedAt.current.at;
      if (elapsed > POLL_BUDGET_MS) return false;
      return testPollInterval(elapsed);
    },
    retry: false,
  });

  const settled = !!query.data && query.data.status !== 'pending';
  return {
    delivery: query.data ?? null,
    settled,
    /** The budget ran out with the delivery still pending — not a result. */
    timedOut: !!deliveryId && !settled && Date.now() - startedAt.current.at > POLL_BUDGET_MS,
  };
}

/** Send a test ping. Returns the created delivery id (202). */
export function useTestWebhook(scope: IntegrationScope) {
  const qc = useQueryClient();
  return useMutation<{ delivery_id: string }, Error, string>({
    mutationFn: async (id) => {
      const res = await apiClient.post<{ delivery_id: string }>(`${basePath(scope)}${id}/test/`);
      return res.data;
    },
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: [...webhooksKey(scope), id, 'deliveries'] });
    },
  });
}
