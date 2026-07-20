import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

interface CreateGroupPayload {
  name: string;
  description?: string;
  lead?: string;
}

interface UpdateGroupPayload {
  id: string;
  name?: string;
  description?: string;
  lead?: string | null;
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateGroupPayload) => {
      const res = await apiClient.post('/workspace/groups/', payload);
      return res.data as unknown;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-groups'] });
    },
  });
}

export function useUpdateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateGroupPayload) => {
      const res = await apiClient.patch(`/workspace/groups/${id}/`, body);
      return res.data as unknown;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-groups'] });
    },
  });
}

export function useDeleteGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (groupId: string) => {
      await apiClient.delete(`/workspace/groups/${groupId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-groups'] });
    },
  });
}

interface AddGroupMemberPayload {
  groupId: string;
  userId: string;
}

interface RemoveGroupMemberPayload {
  groupId: string;
  userId: string;
}

export function useAddGroupMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ groupId, userId }: AddGroupMemberPayload) => {
      const res = await apiClient.post(`/workspace/groups/${groupId}/members/`, { user: userId });
      return res.data as unknown;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-groups'] });
    },
  });
}

export function useRemoveGroupMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ groupId, userId }: RemoveGroupMemberPayload) => {
      await apiClient.delete(`/workspace/groups/${groupId}/members/${userId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-groups'] });
    },
  });
}

interface GrantGroupProjectPayload {
  groupId: string;
  projectId: string;
  /** Role ordinal to confer on the group's members for this project (< Owner). */
  role: number;
}

interface RevokeGroupProjectPayload {
  groupId: string;
  projectId: string;
}

/**
 * Grant a group access to a project at a conferred role (#2253). The server's
 * reconcile_group_access cascade materializes a ProjectMembership for every
 * group member at this role.
 */
export function useGrantGroupProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ groupId, projectId, role }: GrantGroupProjectPayload) => {
      const res = await apiClient.post(`/workspace/groups/${groupId}/projects/`, {
        project: projectId,
        role,
      });
      return res.data as unknown;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-groups'] });
    },
  });
}

/** Revoke a group's access to a project (#2253). */
export function useRevokeGroupProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ groupId, projectId }: RevokeGroupProjectPayload) => {
      await apiClient.delete(`/workspace/groups/${groupId}/projects/${projectId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-groups'] });
    },
  });
}
