import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Velocity-calibration suggestion (ADR-0065).
 *
 * Generated on sprint close from rolling team velocity. The PM accepts (writes
 * `most_likely_duration`) or dismisses (audit-only) from the Task Detail Drawer.
 */
export interface VelocitySuggestion {
  id: string;
  task: string;
  sprint_id: string;
  sprint_name: string;
  // Both are nulled by the server's ADR-0104 velocity gate (#949/#1099) when the
  // reader is below the velocity audience — e.g. a PM at the team-private default.
  suggested_duration: number | null;
  team_velocity_per_day: string | null;
  flag_for_review: boolean;
  is_pending: boolean;
  created_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
}

interface PaginatedResponse<T> {
  count: number;
  results: T[];
}

/**
 * GET /api/v1/velocity-suggestions/?task={taskId}&pending=true
 *
 * Returns the pending velocity-calibration suggestion(s) for a task. Usually
 * 0 or 1 row — sprint close generates one suggestion per task, and a settled
 * decision (accepted or dismissed) removes the row from the pending filter.
 */
export function useVelocitySuggestions(taskId: string | undefined) {
  return useQuery({
    queryKey: ['velocity-suggestions', taskId],
    enabled: Boolean(taskId),
    queryFn: async (): Promise<VelocitySuggestion[]> => {
      const res = await apiClient.get<PaginatedResponse<VelocitySuggestion>>(
        `/velocity-suggestions/?task=${taskId}&pending=true`,
      );
      return res.data.results;
    },
  });
}

/**
 * GET /api/v1/velocity-suggestions/?pending=true
 *
 * Every pending velocity-calibration suggestion across the caller's projects
 * (the endpoint is membership-gated server-side; the rows carry `sprint_id`).
 * The sprint-surface reforecast panel filters these to a single sprint so the
 * Scrum Master who just closed a sprint can accept/dismiss the velocity→duration
 * reforecast in place, instead of opening each task's drawer (#1290). The cache
 * key is project-agnostic — the response is the same regardless of which project
 * surface mounts it — but the fetch is gated on being inside a project route.
 */
export function usePendingVelocitySuggestions(projectId: string | undefined) {
  return useQuery({
    queryKey: ['velocity-suggestions', 'pending'],
    enabled: Boolean(projectId),
    queryFn: async (): Promise<VelocitySuggestion[]> => {
      const res = await apiClient.get<PaginatedResponse<VelocitySuggestion>>(
        `/velocity-suggestions/?pending=true`,
      );
      return res.data.results;
    },
  });
}

/**
 * Project-scoped accept/dismiss for the sprint-surface reforecast panel.
 *
 * Unlike the task-scoped {@link useAcceptVelocitySuggestion}/{@link useDismissVelocitySuggestion}
 * (which the task drawer uses, keyed by one task), these invalidate *all*
 * velocity-suggestion queries — both the task-scoped banners and the project
 * pending list — so a settled suggestion drops out of every surface at once.
 * Accept also refreshes the project tasks (`['tasks', projectId]`, shared by the
 * drawer and useScheduleTasks) since `most_likely_duration` changed.
 */
export function useAcceptSprintVelocitySuggestion(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (suggestionId: string) => {
      const res = await apiClient.post<VelocitySuggestion>(
        `/velocity-suggestions/${suggestionId}/accept/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['velocity-suggestions'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

export function useDismissSprintVelocitySuggestion(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (suggestionId: string) => {
      const res = await apiClient.post<VelocitySuggestion>(
        `/velocity-suggestions/${suggestionId}/dismiss/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['velocity-suggestions'] });
      // Keep projectId in the signature so callers wire the same surface and a
      // future optimistic update has the project handle; the dismiss is audit-only
      // so no task refresh is needed today.
      void projectId;
    },
  });
}

/**
 * POST /api/v1/velocity-suggestions/{id}/accept/
 *
 * Applies the suggested duration to the task and enqueues a CPM recompute.
 * Idempotent: re-accepting a settled suggestion returns 200 with the existing
 * row; dismissing-after-accept returns 409 to preserve the audit trail.
 *
 * On success, invalidates:
 *  - the velocity-suggestion query for this task (settled suggestions drop out
 *    of the pending filter)
 *  - the tasks query for the project (most_likely_duration changed, drawer
 *    needs the fresh value)
 */
export function useAcceptVelocitySuggestion(taskId: string, projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (suggestionId: string) => {
      const res = await apiClient.post<VelocitySuggestion>(
        `/velocity-suggestions/${suggestionId}/accept/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['velocity-suggestions', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

/**
 * POST /api/v1/velocity-suggestions/{id}/dismiss/
 *
 * Records the PM's dismissal without touching the task. Audit-only. Idempotent
 * on a settled suggestion (200 with the existing row); rejected with 409 if the
 * suggestion was already accepted.
 *
 * Invalidates the velocity-suggestion query so the banner stops rendering.
 */
export function useDismissVelocitySuggestion(taskId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (suggestionId: string) => {
      const res = await apiClient.post<VelocitySuggestion>(
        `/velocity-suggestions/${suggestionId}/dismiss/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['velocity-suggestions', taskId] });
    },
  });
}
