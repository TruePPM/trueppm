import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { RoleContext } from '@/hooks/useCurrentUser';

interface ProfileResponse {
  role_context: RoleContext;
}

/**
 * PATCH /api/v1/auth/me/profile/ — set the caller's role-context lens (issue 412,
 * ADR-0161). Mirrors `useUpdateDefaultLanding`: on success the `['current-user']`
 * query is invalidated so every consumer of `role_context` (the view bar, the
 * project-entry redirect, the switcher itself) re-reads the new lens.
 *
 * Choice validation is server-side (400 on a bad value); callers surface the
 * error inline and leave the control re-enabled to retry.
 */
export function useUpdateRoleContext(): UseMutationResult<ProfileResponse, Error, RoleContext> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: RoleContext) => {
      const res = await apiClient.patch<ProfileResponse>('/auth/me/profile/', {
        role_context: value,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['current-user'] });
    },
  });
}
