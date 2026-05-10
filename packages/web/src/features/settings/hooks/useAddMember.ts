import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ProjectMembership } from '@/api/types';

interface AddMemberPayload {
  user: string;
  role: number;
}

export function useAddMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: AddMemberPayload) => {
      const res = await apiClient.post<ProjectMembership>(
        `/projects/${projectId}/members/`,
        payload,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members', projectId] });
    },
  });
}
