import { useInfiniteQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';

export interface TaskHistoryDiff {
  field: string;
  old: string | null;
  new: string | null;
}

export interface TaskHistoryRecord {
  id: number;
  history_date: string;
  /** '+' = created, '~' = changed, '-' = deleted */
  history_type: '+' | '~' | '-';
  /** Username of the author; null for programmatic writes. Stable identity key. */
  history_user: string | null;
  /** Human label to render: full name, username fallback; null when history_user is null. */
  history_user_display: string | null;
  diff: TaskHistoryDiff[];
}

/**
 * GET /api/v1/projects/{projectId}/tasks/{taskId}/history/
 *
 * Paginated field-diff audit trail for a single task.  Uses infinite query
 * so the History tab can append records without losing scroll position.
 */
export function useTaskHistory(projectId: string, taskId: string) {
  return useInfiniteQuery({
    queryKey: ['task-history', projectId, taskId],
    queryFn: async ({ pageParam = 1 }) => {
      const res = await apiClient.get<PaginatedResponse<TaskHistoryRecord>>(
        `/projects/${projectId}/tasks/${taskId}/history/`,
        { params: { page: pageParam } },
      );
      return res.data;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, _pages, lastPageParam) =>
      lastPage.next ? lastPageParam + 1 : undefined,
  });
}
