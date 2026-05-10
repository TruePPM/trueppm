import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ProjectMembership } from '@/api/types';

interface UpdateRolePayload {
  membershipId: string;
  role: number;
}

export function useUpdateMemberRole(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ membershipId, role }: UpdateRolePayload) => {
      const res = await apiClient.patch<ProjectMembership>(
        `/projects/${projectId}/members/${membershipId}/`,
        { role },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members', projectId] });
    },
  });
}
