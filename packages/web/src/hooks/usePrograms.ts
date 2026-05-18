import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse, Program } from '@/api/types';

/**
 * GET /api/v1/programs/ — programs the current user is a member of (ADR-0070).
 *
 * Cached under ``['programs']`` so a single fetch services the sidebar
 * section, the /programs list page, and any header surface that needs to
 * count "how many programs do I belong to".
 */
export function usePrograms(): UseQueryResult<Program[]> {
  return useQuery({
    queryKey: ['programs'],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<Program> | Program[]>('/programs/');
      // The router uses DRF default pagination on list endpoints, but some
      // local fixtures return a bare array — handle both for resilience.
      const data = res.data;
      return Array.isArray(data) ? data : data.results;
    },
  });
}
