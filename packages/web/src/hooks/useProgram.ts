import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Program } from '@/api/types';

/**
 * GET /api/v1/programs/{id}/ — single program detail (ADR-0070).
 *
 * Returns the program with annotated ``my_role``, ``project_count``, and
 * ``member_count``. Disabled when ``programId`` is falsy.
 */
export function useProgram(programId: string | undefined): UseQueryResult<Program> {
  return useQuery({
    queryKey: ['programs', programId],
    queryFn: async () => {
      const res = await apiClient.get<Program>(`/programs/${programId}/`);
      return res.data;
    },
    enabled: !!programId,
  });
}
