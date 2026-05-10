import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { UserSearchResult } from '@/api/types';

export function useUserSearch(q: string): UseQueryResult<UserSearchResult[]> {
  return useQuery({
    queryKey: ['user-search', q],
    queryFn: async () => {
      const res = await apiClient.get<UserSearchResult[]>('/users/search/', { params: { q } });
      return res.data;
    },
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
}
