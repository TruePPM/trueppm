import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { DefaultLanding } from '@/hooks/useCurrentUser';

interface ProfileResponse {
  default_landing: DefaultLanding;
}

/**
 * PATCH /api/v1/auth/me/profile/ — set the caller's default landing preference
 * (ADR-0129). On success the `['current-user']` query is invalidated so the
 * resolved `landing` (and `default_landing`) re-fetch; the new home applies on
 * the *next* login / `/` hit, so callers do NOT navigate after saving.
 *
 * Choice validation is server-side (400 on a bad value); the caller surfaces the
 * error inline and leaves the control re-enabled to retry.
 */
export function useUpdateDefaultLanding(): UseMutationResult<
  ProfileResponse,
  Error,
  DefaultLanding
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: DefaultLanding) => {
      const res = await apiClient.patch<ProfileResponse>('/auth/me/profile/', {
        default_landing: value,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['current-user'] });
    },
  });
}
