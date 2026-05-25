import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

interface UpdateMemberPayload {
  userId: string;
  role?: number;
  status?: string;
}

export function useUpdateWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role, status }: UpdateMemberPayload) => {
      const body: Record<string, unknown> = {};
      if (role !== undefined) body.role = role;
      if (status !== undefined) body.status = status;
      const res = await apiClient.patch(`/workspace/members/${userId}/`, body);
      return res.data as unknown;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
    },
  });
}

export function useRemoveWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await apiClient.delete(`/workspace/members/${userId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
    },
  });
}
