import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ProgramMembership } from '@/api/types';

/**
 * GET /api/v1/programs/{id}/members/ — members of a program (ADR-0070).
 *
 * Mirrors :func:`useMembers` for ProjectMembership. The MembersTab UI accepts
 * either via a shared shape so the only difference at the hook boundary is the
 * endpoint and the cache key.
 */
export function useProgramMembers(
  programId: string | undefined,
): UseQueryResult<ProgramMembership[]> {
  return useQuery({
    queryKey: ['program-members', programId],
    queryFn: async () => {
      const res = await apiClient.get<ProgramMembership[]>(
        `/programs/${programId}/members/`,
      );
      return res.data;
    },
    enabled: !!programId,
  });
}
