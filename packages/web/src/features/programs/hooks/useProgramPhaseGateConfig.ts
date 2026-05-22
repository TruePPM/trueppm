import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PhaseGateConfig } from '@/api/types';

/**
 * GET /api/v1/programs/{id}/phase-gate-config/ — singleton phase-gate template
 * (ADR-0079). The server lazy-creates the row with defaults
 * (``enabled=false``, ``invite_template=""``) so the hook always resolves
 * to a record for an authorised caller; ``isError`` only fires on transport
 * or permission failures.
 */
export function useProgramPhaseGateConfig(
  programId: string | undefined,
): UseQueryResult<PhaseGateConfig> {
  return useQuery({
    queryKey: ['program-phase-gate-config', programId],
    queryFn: async () => {
      const res = await apiClient.get<PhaseGateConfig>(
        `/programs/${programId}/phase-gate-config/`,
      );
      return res.data;
    },
    enabled: !!programId,
  });
}

export interface PhaseGateConfigPatch {
  enabled?: boolean;
  invite_template?: string;
}

export function useUpdateProgramPhaseGateConfig(
  programId: string,
): UseMutationResult<PhaseGateConfig, Error, PhaseGateConfigPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch) => {
      const res = await apiClient.patch<PhaseGateConfig>(
        `/programs/${programId}/phase-gate-config/`,
        patch,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['program-phase-gate-config', programId],
      });
    },
  });
}
