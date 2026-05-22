import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { CeremonyTemplate, PaginatedResponse } from '@/api/types';

/**
 * GET /api/v1/programs/{id}/ceremonies/ — list ceremony templates for a program (ADR-0079).
 *
 * The endpoint paginates with DRF's PageNumberPagination envelope; this hook
 * unwraps ``results`` so consumers get a plain array. Ceremony lists are short
 * (a typical program has 3–8 ceremonies); pagination is the global default,
 * not a feature requirement.
 */
export function useProgramCeremonies(
  programId: string | undefined,
): UseQueryResult<CeremonyTemplate[]> {
  return useQuery({
    queryKey: ['program-ceremonies', programId],
    queryFn: async () => {
      const res = await apiClient.get<
        CeremonyTemplate[] | PaginatedResponse<CeremonyTemplate>
      >(`/programs/${programId}/ceremonies/`);
      const data = res.data;
      return Array.isArray(data) ? data : data.results;
    },
    enabled: !!programId,
  });
}
