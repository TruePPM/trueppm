import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { WorkspaceInvite } from '@/api/types';
import { mapInviteToWorkspaceInvite, type WorkspaceInviteRaw } from './useWorkspaceMembers';

export function useWorkspaceInvites() {
  return useQuery({
    queryKey: ['workspace-invites'],
    queryFn: async () => {
      const res = await apiClient.get<WorkspaceInviteRaw[]>('/workspace/invites/');
      return res.data.map(mapInviteToWorkspaceInvite);
    },
  });
}

interface CreateInvitePayload {
  email: string;
  role: number;
}

export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateInvitePayload) => {
      const res = await apiClient.post<WorkspaceInvite>('/workspace/invites/', payload);
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-invites'] });
    },
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      await apiClient.delete(`/workspace/invites/${inviteId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-invites'] });
    },
  });
}
