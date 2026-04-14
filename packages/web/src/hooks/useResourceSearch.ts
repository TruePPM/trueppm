import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';

export interface ResourceSearchResult {
  id: string;
  name: string;
}

interface ApiResource {
  id: string;
  name: string;
}

export function useResourceSearch(query: string) {
  return useQuery({
    queryKey: ['resources', 'search', query],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiResource>>('/resources/', {
        params: { search: query },
      });
      return res.data.results.map((r): ResourceSearchResult => ({ id: r.id, name: r.name }));
    },
    staleTime: 30_000,
  });
}
