import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Program-scoped external stakeholder registry hooks (#1658, ADR-0264).
 *
 * External stakeholders are non-account people (client sponsors, vendor contacts,
 * external reviewers) included in the `@program-stakeholders` mention fan-out
 * alongside the program's Viewer-role members. Types are declared locally
 * (mirroring {@link useProgramMentionGroups}) because `@/api/types` regenerates
 * only against a live schema server; the shapes match `ExternalStakeholderSerializer`.
 *
 * Email delivery to these addresses is not wired yet — the registry ships first
 * (#1658); delivery follows in #1675.
 */

export interface ExternalStakeholder {
  id: string;
  name: string;
  email: string;
  note: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const key = (programId: string | undefined) => ['program-external-stakeholders', programId];

export function useProgramExternalStakeholders(
  programId: string | undefined,
): UseQueryResult<ExternalStakeholder[]> {
  return useQuery({
    queryKey: key(programId),
    queryFn: async () => {
      const res = await apiClient.get<ExternalStakeholder[]>(
        `/programs/${programId}/external-stakeholders/`,
      );
      return res.data;
    },
    enabled: !!programId,
  });
}

interface CreateStakeholderPayload {
  name: string;
  email: string;
  note?: string;
}

interface UpdateStakeholderPayload {
  id: string;
  name?: string;
  email?: string;
  note?: string;
}

/**
 * External stakeholder mutations, each invalidating the registry list on success.
 * Mirrors {@link useProgramMentionGroupMutations}.
 */
export function useProgramExternalStakeholderMutations(programId: string) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: key(programId) });
  const base = `/programs/${programId}/external-stakeholders`;

  const create = useMutation({
    mutationFn: async (payload: CreateStakeholderPayload) => {
      const res = await apiClient.post<ExternalStakeholder>(`${base}/`, payload);
      return res.data;
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: async ({ id, ...body }: UpdateStakeholderPayload) => {
      const res = await apiClient.patch<ExternalStakeholder>(`${base}/${id}/`, body);
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

  return { create, update, remove };
}
