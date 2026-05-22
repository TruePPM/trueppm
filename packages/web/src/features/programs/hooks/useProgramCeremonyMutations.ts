import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { CeremonyTemplate } from '@/api/types';

/** Payload for create — server fills program, created_by, timestamps. */
export interface CeremonyCreatePayload {
  name: string;
  cadence_type: CeremonyTemplate['cadence_type'];
  cadence_day: string;
  cadence_time: string | null;
  duration_minutes: number;
  owner_role: string;
  enabled: boolean;
}

/** Payload for partial update — every field optional; toggle sends just enabled. */
export type CeremonyPatchPayload = Partial<CeremonyCreatePayload>;

export function useCreateCeremony(
  programId: string,
): UseMutationResult<CeremonyTemplate, Error, CeremonyCreatePayload> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      const res = await apiClient.post<CeremonyTemplate>(
        `/programs/${programId}/ceremonies/`,
        payload,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['program-ceremonies', programId] });
    },
  });
}

export function useUpdateCeremony(
  programId: string,
): UseMutationResult<
  CeremonyTemplate,
  Error,
  { ceremonyId: string; patch: CeremonyPatchPayload }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ceremonyId, patch }) => {
      const res = await apiClient.patch<CeremonyTemplate>(
        `/programs/${programId}/ceremonies/${ceremonyId}/`,
        patch,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['program-ceremonies', programId] });
    },
  });
}

export function useDeleteCeremony(
  programId: string,
): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ceremonyId: string) => {
      await apiClient.delete(`/programs/${programId}/ceremonies/${ceremonyId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['program-ceremonies', programId] });
    },
  });
}
