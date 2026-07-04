/**
 * Hooks for GET /api/v1/admin/failed-tasks/ and GET /api/v1/admin/failed-tasks/{id}/.
 *
 * Scoped to workspace admins. The list hook accepts a filter object so the
 * DeadLetterInspectorPage can drive filtering without managing query keys manually.
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';

// ---------------------------------------------------------------------------
// API response shapes (hand-declared; do NOT edit src/api/types.ts).
// ---------------------------------------------------------------------------

export type FailedTaskStatus = 'pending_retry' | 'dead' | 'dismissed' | 'retried';

export interface FailedTask {
  id: string;
  task_name: string;
  task_id: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
  exception_type: string;
  exception_message: string;
  traceback: string;
  failure_count: number;
  first_failed_at: string;
  last_failed_at: string;
  status: FailedTaskStatus;
  /** Operator-action audit (ADR-0210). Populated once a task is requeued/dropped. */
  resolution_note: string;
  resolved_by_display: string | null;
  resolved_at: string | null;
}

// ---------------------------------------------------------------------------
// Filter shape
// ---------------------------------------------------------------------------

export interface FailedTaskFilters {
  status?: FailedTaskStatus | '';
  task_name?: string;
  /** ISO string — filter records with last_failed_at >= this value. */
  failed_after?: string;
  /** ISO string — filter records with last_failed_at <= this value. */
  failed_before?: string;
}

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

export const failedTasksKeys = {
  all: ['failed-tasks'] as const,
  list: (filters: FailedTaskFilters) => [...failedTasksKeys.all, 'list', filters] as const,
  detail: (id: string) => [...failedTasksKeys.all, 'detail', id] as const,
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Paginated list of failed tasks with optional filter params.
 * Refetches automatically when `filters` changes (new query key).
 */
export function useFailedTasks(filters: FailedTaskFilters) {
  return useQuery<PaginatedResponse<FailedTask>, Error>({
    queryKey: failedTasksKeys.list(filters),
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filters.status) params.status = filters.status;
      if (filters.task_name) params.task_name = filters.task_name;
      if (filters.failed_after) params.failed_after = filters.failed_after;
      if (filters.failed_before) params.failed_before = filters.failed_before;
      const res = await apiClient.get<PaginatedResponse<FailedTask>>('/admin/failed-tasks/', { params });
      return res.data;
    },
    retry: false,
  });
}

/**
 * Single failed-task detail (full payload including traceback, args, kwargs).
 * Only fetches when `id` is non-null so the inspector can keep the query
 * mounted at all times and enable/disable based on selection state.
 */
export function useFailedTask(id: string | null) {
  return useQuery<FailedTask, Error>({
    queryKey: failedTasksKeys.detail(id ?? ''),
    queryFn: async () => {
      const res = await apiClient.get<FailedTask>(`/admin/failed-tasks/${id}/`);
      return res.data;
    },
    enabled: id !== null && id !== '',
    retry: false,
  });
}
