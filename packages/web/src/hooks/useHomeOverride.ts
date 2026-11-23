import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

interface ProfileResponse {
  home_override: 'rm' | null;
}

/**
 * PATCH /api/v1/auth/me/profile/ `{home_override}` — choose the Resource Manager home
 * (`'rm'`) or return to the role-resolved one (`null`). The server clears the override
 * whenever `default_landing` is written, so the two are always separate requests.
 * Invalidates `['current-user']` so the re-resolved `landing.home` reads back.
 */
export function useUpdateHomeOverride(): UseMutationResult<ProfileResponse, Error, 'rm' | null> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: 'rm' | null) => {
      const res = await apiClient.patch<ProfileResponse>('/auth/me/profile/', {
        home_override: value,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['current-user'] });
    },
  });
}
