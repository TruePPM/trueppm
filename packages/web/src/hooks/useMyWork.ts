/**
 * Hook for the My Work contributor surface (issue #499, ADR-0065 Gap 2).
 *
 * Fetches GET /api/v1/me/work/ — the user's cross-project task list with
 * cursor pagination, active sprint cards, and a due-today count for the
 * Sidebar badge.
 *
 * Status updates happen via the existing task PATCH endpoint with header
 * ``X-Source: my_work`` (see ``useMyWorkStatusUpdate`` below). Updates
 * are optimistic; rollback on failure with a toast.
 */
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  useInfiniteQuery,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { TaskStatus } from '@/types';
import type { BlockerType } from '@/lib/blocker';

export type DueSource = 'actual' | 'planned' | 'estimated' | 'sprint' | null;

/** Server-computed My Work section (#484, ADR-0122). */
export type MyWorkGroup = 'today' | 'this_sprint' | 'upcoming';

export interface MyWorkTask {
  id: string;
  short_id: string;
  name: string;
  project_id: string;
  project_name: string;
  /**
   * Program identity (#964, follow-up to #963). My Work spans programs, so each
   * row carries its program's accent + name for cross-program wayfinding. All
   * three are null for an orphan project (no program) — the row then renders the
   * neutral unset ProgramIdentitySquare with no name. The square is decorative
   * (`aria-hidden`); `program_name` is the accessible signal.
   */
  program_id: string | null;
  program_name: string | null;
  program_color: string | null;
  sprint_id: string | null;
  sprint_name: string | null;
  status: TaskStatus;
  story_points: number | null;
  remaining_points: number | null;
  due: string | null;
  due_source: DueSource;
  is_critical: boolean;
  /**
   * Server-computed bucket (#484, ADR-0122): the section this task renders under.
   * Sorted contiguously in the response so the page groups by a simple boundary
   * walk, never re-deriving date math client-side.
   */
  group: MyWorkGroup;
  /**
   * Explicit human blocker (#476/#855). `true` ⇔ a teammate flagged this task as
   * blocked; `blocked_reason` carries why. Distinct from the board card's
   * dependency-readiness signal — on this contributor surface "blocked" means
   * the human flag. Blocked tasks sort first within their group.
   */
  is_blocked: boolean;
  blocked_reason: string;
  /**
   * ADR-0124 (#1135) structured blocker — the team-shareable triage signal.
   * `blocker_type` classifies the impediment (empty string when only free text
   * was recorded); `blocked_age_seconds` is the server-computed age the row's
   * "Xd Yh blocked" badge renders (null when the task is not flagged).
   */
  blocker_type: BlockerType | '';
  blocked_age_seconds: number | null;
  server_version: number;
  url: string;
  /**
   * Sprint scope-injection pending flag (ADR-0102 §6). When `true`, the task
   * was injected into its active sprint and is awaiting team acceptance — the
   * row renders a muted "Pending acceptance" chip and NO accept/reject controls
   * (the decision is team-owned and never surfaces in the contributor me tree).
   * Snake_case wire key (`MeWorkTaskSerializer.sprint_pending`). */
  sprint_pending?: boolean;
}

export interface MyWorkActiveSprint {
  id: string;
  name: string;
  project_id: string;
  project_name: string;
  finish_date: string;
  days_remaining: number;
  task_count: number;
}

export interface MyWorkRetroActionItem {
  suggestion_state: 'suggested' | 'owned';
  suggestion_id: string | null;
  task_id: string;
  task_status: TaskStatus;
  task_short_id: string | null;
  text: string;
  from_retro_id: string;
  from_sprint_id: string;
  from_sprint_short_id: string | null;
  suggested_by_id: number | null;
  suggested_by_username: string | null;
  reason: string;
  age_days: number;
  story_points: number | null;
}

/** One real burndown datapoint for the lead active sprint (#1236). */
export interface MyWorkBurndownPoint {
  date: string;
  remaining_points: number;
}

/**
 * Cross-program focus-card signals (#1236, ADR-0221). Each field is present only
 * when a real server-side computation backs it (rule 120: never fabricated). An
 * absent field means "no data source" — the corresponding card enrichment is
 * honestly omitted rather than approximated. Utilization is deliberately never
 * present: there is no cross-program per-user capacity computation to back it.
 */
export interface MyWorkSignals {
  /** Worst-first SPI-proxy schedule-health band across the user's member projects. */
  schedule_health?: {
    band: 'on_track' | 'at_risk' | 'critical';
    /** Projects contributing a real (non-unknown) band. */
    project_count: number;
  };
  /** Latest Monte-Carlo P80 ship-date across the user's forecasted projects. */
  forecast?: {
    p80_finish: string;
    project_id: string;
    project_name: string;
    /** ISO timestamp of the driving run — freshness of the forecast. */
    as_of: string;
  };
  /** Real per-day burn series for the user's soonest-ending active sprint. */
  sprint_burndown?: {
    sprint_id: string;
    sprint_name: string;
    committed_points: number;
    series: MyWorkBurndownPoint[];
    burn_status: 'ahead' | 'on_track' | 'behind' | 'no_data';
    /** Signed points vs the ideal line; positive = ahead. Null when no baseline. */
    trend_points: number | null;
    projected_finish_date: string | null;
  };
}

export interface MyWorkPage {
  results: MyWorkTask[];
  next: string | null;
  previous: string | null;
  active_sprints: MyWorkActiveSprint[];
  due_today_count: number;
  server_version_high_water: number;
  /** Retro action items relevant to the requesting user (ADR-0071 §4c). */
  retro_action_items: MyWorkRetroActionItem[];
  /**
   * Cross-program focus-card aggregates (#1236). Present on the first page only;
   * `undefined` on subsequent pages and when the payload predates this field.
   */
  signals?: MyWorkSignals;
}

/**
 * Paginated fetch of the user's tasks across all projects.
 *
 * Returns a flat task list plus minimal active-sprint cards (for group
 * headers) and a `due_today_count` used by the Sidebar badge. Subsequent
 * pages are fetched via TanStack Query's `useInfiniteQuery` cursor model.
 *
 * `refetchOnWindowFocus` is on so a user returning from another tab — where
 * they may have changed task state — sees fresh data without a manual reload.
 */
export function useMyWork() {
  return useInfiniteQuery<MyWorkPage>({
    queryKey: ['me', 'work'],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const url = (pageParam as string | null) ?? '/me/work/';
      // Cursors come from the server as fully-qualified next/previous URLs.
      // axios will strip the host when paired with the configured baseURL.
      const res = await apiClient.get<MyWorkPage>(url);
      return res.data;
    },
    getNextPageParam: (lastPage) => lastPage.next,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

interface StatusUpdateArgs {
  taskId: string;
  next: TaskStatus;
  /** Previous status — used to roll back optimistically on error. */
  previous: TaskStatus;
}

/**
 * Status update from the /me/work surface.
 *
 * Fires `PATCH /api/v1/tasks/{id}/` with `X-Source: my_work` so the backend
 * webhook payload carries the originating surface. Optimistically updates
 * the cached `useMyWork` pages and rolls back on error.
 */
export function useMyWorkStatusUpdate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ taskId, next }: StatusUpdateArgs) => {
      const res = await apiClient.patch<unknown>(
        `/tasks/${taskId}/`,
        { status: next },
        { headers: { 'X-Source': 'my_work' } },
      );
      return res.data;
    },
    onMutate: async ({ taskId, next }) => {
      await queryClient.cancelQueries({ queryKey: ['me', 'work'] });
      const snapshot = queryClient.getQueryData<InfiniteData<MyWorkPage>>(['me', 'work']);
      queryClient.setQueryData<InfiniteData<MyWorkPage>>(['me', 'work'], (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            results: page.results.map((t) => (t.id === taskId ? { ...t, status: next } : t)),
          })),
        };
      });
      return { snapshot };
    },
    onError: (_err, _vars, ctx) => {
      // Restore the prior cache; a toast layer surfaces the failure to the user.
      if (ctx?.snapshot) {
        queryClient.setQueryData(['me', 'work'], ctx.snapshot);
      }
    },
    onSettled: () => {
      // Refresh once the server confirms — keeps due_today_count and
      // active_sprints in sync (the patch may have closed a sprint task etc.).
      void queryClient.invalidateQueries({ queryKey: ['me', 'work'] });
    },
  });
}
