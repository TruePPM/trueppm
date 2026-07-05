import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * User-defined @mention group hooks (ADR-0212, issue 515).
 *
 * Types are declared locally rather than pulled from the generated
 * `@/api/types` because that file regenerates only against a live schema
 * server; mirroring `useCurrentUserRole`'s local-interface pattern keeps the
 * feature self-contained. The shapes match
 * `UserDefinedMentionGroupReadSerializer`.
 */

export interface MentionGroupMember {
  id: string;
  username: string;
  email: string;
}

export interface MentionGroup {
  id: string;
  server_version: number;
  project: string;
  name: string;
  description: string;
  email_default_on: boolean;
  members: MentionGroupMember[];
  member_count: number;
  muted_by_me: boolean;
}

const key = (projectId: string | undefined) => ['mention-groups', projectId];

export function useMentionGroups(
  projectId: string | undefined,
): UseQueryResult<MentionGroup[]> {
  return useQuery({
    queryKey: key(projectId),
    queryFn: async () => {
      const res = await apiClient.get<MentionGroup[]>(
        `/projects/${projectId}/mention-groups/`,
      );
      return res.data;
    },
    enabled: !!projectId,
  });
}

interface CreateGroupPayload {
  name: string;
  description?: string;
}

interface UpdateGroupPayload {
  id: string;
  name?: string;
  description?: string;
  email_default_on?: boolean;
}

interface MemberPayload {
  id: string;
  user: string;
}

/**
 * All group mutations for a project, each invalidating the group list on
 * success. Membership/mute POSTs return the refreshed group so the list
 * reflects the change on the next fetch.
 */
export function useMentionGroupMutations(projectId: string) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: key(projectId) });
  const base = `/projects/${projectId}/mention-groups`;

  const create = useMutation({
    mutationFn: async (payload: CreateGroupPayload) => {
      const res = await apiClient.post<MentionGroup>(`${base}/`, payload);
      return res.data;
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: async ({ id, ...body }: UpdateGroupPayload) => {
      const res = await apiClient.patch<MentionGroup>(`${base}/${id}/`, body);
      return res.data;
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`${base}/${id}/`);
    },
    onSuccess: invalidate,
  });

  const addMember = useMutation({
    mutationFn: async ({ id, user }: MemberPayload) => {
      const res = await apiClient.post<MentionGroup>(`${base}/${id}/add-member/`, {
        user,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const removeMember = useMutation({
    mutationFn: async ({ id, user }: MemberPayload) => {
      const res = await apiClient.post<MentionGroup>(
        `${base}/${id}/remove-member/`,
        { user },
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  const mute = useMutation({
    mutationFn: async ({ id, muted }: { id: string; muted: boolean }) => {
      const res = await apiClient.post<MentionGroup>(
        `${base}/${id}/${muted ? 'mute' : 'unmute'}/`,
        {},
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  return { create, update, remove, addMember, removeMember, mute };
}
