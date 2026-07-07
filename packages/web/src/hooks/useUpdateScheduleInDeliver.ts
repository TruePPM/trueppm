import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

interface ScheduleInDeliverResponse {
  schedule_in_deliver: boolean;
}

/**
 * PATCH /api/v1/auth/me/profile/ — set the caller's Schedule-in-Deliver placement
 * opt-in (ADR-0203, #1645). A single boolean: when true the shell *additionally*
 * surfaces Schedule under Deliver (display-only, never affects rollups/reports/
 * exports).
 *
 * On success the `['current-user']` query is invalidated so `schedule_in_deliver`
 * (read from `/auth/me/`) re-fetches and the view composition recomposes through
 * the single `groupedVisibleViewsForUser` path. Callers drive an optimistic local
 * toggle and revert on error (the `useUpdateHiddenViews` pattern), so the menu
 * feels instant.
 */
export function useUpdateScheduleInDeliver(): UseMutationResult<
  ScheduleInDeliverResponse,
  Error,
  boolean
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: boolean) => {
      const res = await apiClient.patch<ScheduleInDeliverResponse>('/auth/me/profile/', {
        schedule_in_deliver: value,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['current-user'] });
    },
  });
}
