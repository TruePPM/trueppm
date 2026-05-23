import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/** Cross-project dependency slip propagation policy. Closed enum — see #529. */
export type SlipPropagation = 'none' | 'warn' | 'block';

export interface ProgramRiskPolicy {
  slip_propagation: SlipPropagation;
  /** Days a blocked dependency can sit unresolved before escalating (1–30). */
  escalation_days: number;
}

const queryKey = (programId: string | undefined) =>
  ['program-risk-policy', programId] as const;

/** GET /api/v1/programs/:id/risk-policy/ — #529. */
export function useProgramRiskPolicy(
  programId: string | undefined,
): UseQueryResult<ProgramRiskPolicy> {
  return useQuery({
    queryKey: queryKey(programId),
    queryFn: async () => {
      const res = await apiClient.get<ProgramRiskPolicy>(
        `/programs/${programId}/risk-policy/`,
      );
      return res.data;
    },
    enabled: !!programId,
  });
}

/**
 * PATCH /api/v1/programs/:id/risk-policy/ — explicit save (no optimistic
 * update). Both fields submit together so the Unsaved-changes affordance
 * can present a single dirty/save transaction; the API accepts each field
 * partial-updatable so callers may also send one at a time if needed.
 */
export function useSaveProgramRiskPolicy(
  programId: string,
): UseMutationResult<ProgramRiskPolicy, Error, Partial<ProgramRiskPolicy>> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<ProgramRiskPolicy>) => {
      const res = await apiClient.patch<ProgramRiskPolicy>(
        `/programs/${programId}/risk-policy/`,
        patch,
      );
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData<ProgramRiskPolicy>(queryKey(programId), data);
    },
  });
}
