/**
 * Write-action mutations for the dead-letter inspector (#695, ADR-0210).
 *
 * Four workspace-admin operator actions on parked/dead-lettered Celery tasks:
 *   - requeue one (with backoff) / drop one (with note)
 *   - requeue all / drop all over the CURRENT FILTER SET (bounded server-side)
 *
 * Requeue round-trips through the durable workflow backend server-side; the
 * client just POSTs. Every mutation invalidates `failedTasksKeys.all` so the
 * list and the open detail pane both refetch — the acted-on row changes status
 * (→ retried/dismissed) and drops out of the default `dead`/`pending_retry` view.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { failedTasksKeys, type FailedTask, type FailedTaskFilters } from './useFailedTasks';

/** Result shape for the bulk requeue_all / drop_all endpoints. */
export interface BulkActionResult {
  /** How many rows the action actually processed (≤ the server cap). */
  processed: number;
  /** How many rows matched the filter set before the cap was applied. */
  matched: number;
  /** True when `matched` exceeded the cap — more remain; repeat the action. */
  capped: boolean;
}

/** The single-requeue response is the updated task plus the started workflow id. */
export interface RequeueResult extends FailedTask {
  workflow_id: string;
}

/**
 * Translate the inspector's filter object into the query string the bulk
 * endpoints read via the viewset's `get_queryset` — the "current filter set".
 * Kept in one place so requeue_all and drop_all stay in lockstep with the list.
 */
function filtersToQuery(filters: FailedTaskFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.task_name) params.set('task_name', filters.task_name);
  if (filters.failed_after) params.set('failed_after', filters.failed_after);
  if (filters.failed_before) params.set('failed_before', filters.failed_before);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** POST /api/v1/admin/failed-tasks/{id}/requeue/ — requeue one with backoff. */
export function useRequeueFailedTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, backoffSeconds }: { id: string; backoffSeconds: number }) => {
      const res = await apiClient.post<RequeueResult>(`/admin/failed-tasks/${id}/requeue/`, {
        backoff_seconds: backoffSeconds,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: failedTasksKeys.all });
    },
  });
}

/** POST /api/v1/admin/failed-tasks/{id}/drop/ — soft-remove one with an optional note. */
export function useDropFailedTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, note }: { id: string; note: string }) => {
      const res = await apiClient.post<FailedTask>(`/admin/failed-tasks/${id}/drop/`, { note });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: failedTasksKeys.all });
    },
  });
}

/** POST /api/v1/admin/failed-tasks/requeue_all/ — requeue the current filter set (bounded). */
export function useRequeueAllFailedTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      filters,
      backoffSeconds,
    }: {
      filters: FailedTaskFilters;
      backoffSeconds: number;
    }) => {
      const res = await apiClient.post<BulkActionResult>(
        `/admin/failed-tasks/requeue_all/${filtersToQuery(filters)}`,
        { backoff_seconds: backoffSeconds },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: failedTasksKeys.all });
    },
  });
}

/** POST /api/v1/admin/failed-tasks/drop_all/ — drop the current filter set (bounded). */
export function useDropAllFailedTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ filters, note }: { filters: FailedTaskFilters; note: string }) => {
      const res = await apiClient.post<BulkActionResult>(
        `/admin/failed-tasks/drop_all/${filtersToQuery(filters)}`,
        { note },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: failedTasksKeys.all });
    },
  });
}

/** Operator-chosen backoff options for requeue (seconds). Bounded set, UI-facing. */
export const BACKOFF_OPTIONS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: 'Immediately', seconds: 0 },
  { label: 'In 5 minutes', seconds: 300 },
  { label: 'In 30 minutes', seconds: 1800 },
  { label: 'In 1 hour', seconds: 3600 },
];
