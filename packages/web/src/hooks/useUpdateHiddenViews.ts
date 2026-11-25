import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

interface HiddenViewsResponse {
  hidden_views: string[];
}

/**
 * PATCH /api/v1/auth/me/profile/ — set the caller's per-user hidden view-keys
 * (ADR-0139). The full desired set is sent each call (not a delta), so the PATCH
 * is naturally idempotent and "Reset to default" is simply `[]`.
 *
 * On success the `['current-user']` query is invalidated so `hidden_views` (read
 * from `/auth/me/`) re-fetches and the view bar recomposes. The write fans out to
 * every project's view set server-side (ADR-1478 §6.2), so every cached
 * `['project-views', …]` set is invalidated as well. Validation is
 * server-side (400 on an unknown/non-hideable key); callers drive an optimistic
 * local toggle state and revert it on error (the `MyGeneralPreferencesPage`
 * pattern), so the menu feels instant.
 */
export function useUpdateHiddenViews(): UseMutationResult<HiddenViewsResponse, Error, string[]> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (views: string[]) => {
      const res = await apiClient.patch<HiddenViewsResponse>('/auth/me/profile/', {
        hidden_views: views,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['current-user'] });
      void queryClient.invalidateQueries({ queryKey: ['project-views'] });
    },
  });
}
