import { useInfiniteQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';

export interface TaskHistoryDiff {
  field: string;
  old: string | null;
  new: string | null;
}

/** Actor shape shared by every merged-feed event (`null` for system/authorless). */
export interface ActivityActor {
  id: string;
  display_name: string;
}

/**
 * One entry in the merged task activity feed (ADR-0207, issue #413/#1883).
 *
 * With `?include=` the endpoint returns a chronological, newest-first merge of
 * every event source. Every entry carries the unified `{event_type, actor,
 * timestamp, detail}` shape; field-diff entries (`task_created`,
 * `fields_changed`, `task_deleted`) additionally retain the legacy
 * `{id, history_type, diff}` keys so the diff renderer keeps working.
 *
 * `detail` is intentionally loosely typed — each `event_type` carries its own
 * payload (see the per-type readers in ActivityTimeline). Narrow at the read
 * site rather than modelling a wide discriminated union that must be kept in
 * lockstep with the backend.
 */
export interface TaskActivityEntry {
  event_type: string;
  actor: ActivityActor | null;
  timestamp: string;
  detail: Record<string, unknown>;
  // Legacy field-diff keys — present only on task_created/fields_changed/task_deleted.
  id?: number;
  /** '+' = created, '~' = changed, '-' = deleted */
  history_type?: '+' | '~' | '-';
  /** ISO timestamp of the change (mirrors `timestamp` on field-diff entries). */
  history_date?: string;
  /** Author username; null for programmatic writes. */
  history_user?: string | null;
  /** Author display label (full name, username fallback). */
  history_user_display?: string | null;
  diff?: TaskHistoryDiff[];
}

/** Back-compat alias — the field-diff shape callers historically imported. */
export type TaskHistoryRecord = TaskActivityEntry;

/** Page envelope adds `count_truncated` (row cap hit) on top of the DRF shape. */
type ActivityPage = PaginatedResponse<TaskActivityEntry> & {
  count_truncated?: boolean;
};

/**
 * Every activity source the drawer surfaces. Adopting `?include=` (issue #1883)
 * is what makes schedule/risk/time/attachment events and the full comment
 * lifecycle (`comment_edited`/`comment_deleted`) appear at all — before this the
 * hook called the plain `/history/` feed and those events were written but never
 * read by any UI.
 */
const ACTIVITY_INCLUDE = 'comments,time,attachments,schedule,risks';

/**
 * GET /api/v1/projects/{projectId}/tasks/{taskId}/history/?include=…
 *
 * Merged, paginated activity feed for a single task. Uses infinite query so the
 * Activity tab can append pages without losing scroll position.
 */
export function useTaskHistory(projectId: string, taskId: string) {
  return useInfiniteQuery({
    // 'merged' scopes the cache to the include-shape so a legacy-shaped page
    // (from an older client build) can never bleed into this consumer.
    queryKey: ['task-history', projectId, taskId, 'merged'],
    queryFn: async ({ pageParam = 1 }) => {
      const res = await apiClient.get<ActivityPage>(
        `/projects/${projectId}/tasks/${taskId}/history/`,
        { params: { page: pageParam, include: ACTIVITY_INCLUDE } },
      );
      return res.data;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, _pages, lastPageParam) =>
      lastPage.next ? lastPageParam + 1 : undefined,
  });
}
