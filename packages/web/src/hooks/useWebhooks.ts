/**
 * Webhook CRUD hooks (#638 / #600), scope-parameterized over project | program.
 *
 * The project and program webhook endpoints are identical in shape (ADR-0076):
 * /api/v1/{scope}s/{id}/webhooks/. One hook set serves both the project and
 * program Integrations pages — the scope is passed in, not hard-coded.
 */

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
      void qc.invalidateQueries({ queryKey: [`${scope.kind}-integrations-summary`, scope.id] });
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
      void qc.invalidateQueries({ queryKey: [`${scope.kind}-integrations-summary`, scope.id] });
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
      void qc.invalidateQueries({ queryKey: [`${scope.kind}-integrations-summary`, scope.id] });
    },
  });
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
