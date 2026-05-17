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
  suggested_duration: number;
  team_velocity_per_day: string;
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
