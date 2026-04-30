import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AxiosError } from 'axios';

export interface CurrentUser {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  email: string;
}

/**
 * Fetches GET /api/v1/auth/me/ and returns the current user's identity.
 * staleTime: 5 min — matches access token lifetime; avoids redundant refetches.
 */
export function useCurrentUser(): { user: CurrentUser | undefined; isLoading: boolean } {
  const { data, isPending } = useQuery<CurrentUser, AxiosError>({
    queryKey: ['current-user'],
    queryFn: async () => {
      const res = await apiClient.get<CurrentUser>('/auth/me/');
      return res.data;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return { user: data, isLoading: isPending };
}
