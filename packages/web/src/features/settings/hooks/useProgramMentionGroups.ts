import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { MentionGroupMember } from './useMentionGroups';

/**
 * Program-scoped user-defined @mention group hooks (ADR-0248, issue 516).
 *
 * The program parallel of {@link useMentionGroups}. Types are declared locally
 * (mirroring that hook) because `@/api/types` regenerates only against a live
 * schema server. The shapes match `ProgramUserDefinedMentionGroupReadSerializer`.
 */

export interface ProgramMentionGroup {
  id: string;
  server_version: number;
  program: string;
  name: string;
  description: string;
  email_default_on: boolean;
  members: MentionGroupMember[];
  member_count: number;
  muted_by_me: boolean;
}

const key = (programId: string | undefined) => ['program-mention-groups', programId];

export function useProgramMentionGroups(
  programId: string | undefined,
): UseQueryResult<ProgramMentionGroup[]> {
  return useQuery({
    queryKey: key(programId),
    queryFn: async () => {
      const res = await apiClient.get<ProgramMentionGroup[]>(
        `/programs/${programId}/mention-groups/`,
      );
      return res.data;
    },
    enabled: !!programId,
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
 * All program-group mutations, each invalidating the group list on success.
 * Membership/mute POSTs return the refreshed group so the list reflects the
 * change on the next fetch. Mirrors {@link useMentionGroupMutations}.
 */
export function useProgramMentionGroupMutations(programId: string) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: key(programId) });
  const base = `/programs/${programId}/mention-groups`;

  const create = useMutation({
    mutationFn: async (payload: CreateGroupPayload) => {
      const res = await apiClient.post<ProgramMentionGroup>(`${base}/`, payload);
      return res.data;
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: async ({ id, ...body }: UpdateGroupPayload) => {
      const res = await apiClient.patch<ProgramMentionGroup>(`${base}/${id}/`, body);
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
      const res = await apiClient.post<ProgramMentionGroup>(`${base}/${id}/add-member/`, {
        user,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const removeMember = useMutation({
    mutationFn: async ({ id, user }: MemberPayload) => {
      const res = await apiClient.post<ProgramMentionGroup>(
        `${base}/${id}/remove-member/`,
        { user },
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  const mute = useMutation({
    mutationFn: async ({ id, muted }: { id: string; muted: boolean }) => {
      const res = await apiClient.post<ProgramMentionGroup>(
        `${base}/${id}/${muted ? 'mute' : 'unmute'}/`,
        {},
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  return { create, update, remove, addMember, removeMember, mute };
}
