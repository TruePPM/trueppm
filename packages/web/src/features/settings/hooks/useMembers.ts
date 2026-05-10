import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ProjectMembership } from '@/api/types';

export function useMembers(projectId: string | undefined): UseQueryResult<ProjectMembership[]> {
  return useQuery({
    queryKey: ['members', projectId],
    queryFn: async () => {
      const res = await apiClient.get<ProjectMembership[]>(
        `/projects/${projectId}/members/`,
      );
      return res.data;
    },
    enabled: !!projectId,
  });
}
