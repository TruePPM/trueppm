import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/** Wire-format identifiers for the rollup KPI toggles. Closed enum — see ADR-0169. */
export type RollupKpi =
  | 'schedule_variance'
  | 'cost_variance'
  | 'budget_utilization'
  | 'schedule_health'
  | 'critical_tasks'
  | 'at_risk_tasks'
  | 'baseline_variance'
  | 'risk_score'
  | 'milestone_health'
  | 'p80_completion';

export type AggregationPolicy =
  | 'worst'
  | 'average'
  | 'weighted_by_budget'
  | 'task_weighted';

/**
 * Stable machine reasons a KPI has no backing data source yet. Mirrors the
 * server's `DEFERRED_KPI_REASONS` and the `reason` returned by `GET /rollup/`
 * for a deferred KPI.
 */
export type UnavailableKpiReason = 'no_cost_data' | 'no_montecarlo_store';

export interface ProgramRollupConfig {
  enabled_kpis: RollupKpi[];
  aggregation_policy: AggregationPolicy;
  /**
   * KPI → why it cannot produce a value yet (#2404). Server-published rather
   * than hard-coded here so the picker unlocks a KPI the moment its backing
   * store lands, with no client release. Optional because a cached response
   * from a pre-#2404 server has no such key — treat a missing map as "all
   * available" and fall back to the previous behavior.
   */
  unavailable_kpis?: Partial<Record<RollupKpi, UnavailableKpiReason>>;
}

const queryKey = (programId: string | undefined) =>
  ['program-rollup-config', programId] as const;

/** GET /api/v1/programs/:id/rollup-config/ — ADR-0169, #527. */
export function useProgramRollupConfig(
  programId: string | undefined,
): UseQueryResult<ProgramRollupConfig> {
  return useQuery({
    queryKey: queryKey(programId),
    queryFn: async () => {
      const res = await apiClient.get<ProgramRollupConfig>(
        `/programs/${programId}/rollup-config/`,
      );
      return res.data;
    },
    enabled: !!programId,
  });
}

interface MutationContext {
  previous: ProgramRollupConfig | undefined;
}

/**
 * PATCH /api/v1/programs/:id/rollup-config/ — optimistic update for KPI
 * toggles (the policy radio uses ``useSaveProgramRollupPolicy`` below which
 * is non-optimistic by design — that surface is governance-shaped per the
 * VoC panel and gets an explicit Save button).
 */
export function useToggleProgramRollupKpi(
  programId: string,
): UseMutationResult<ProgramRollupConfig, Error, RollupKpi[], MutationContext> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled_kpis: RollupKpi[]) => {
      const res = await apiClient.patch<ProgramRollupConfig>(
        `/programs/${programId}/rollup-config/`,
        { enabled_kpis },
      );
      return res.data;
    },
    onMutate: async (next) => {
      const key = queryKey(programId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ProgramRollupConfig>(key);
      if (previous) {
        queryClient.setQueryData<ProgramRollupConfig>(key, {
          ...previous,
          enabled_kpis: next,
        });
      }
      return { previous };
    },
    onError: (_err, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey(programId), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKey(programId) });
    },
  });
}

/**
 * PATCH /api/v1/programs/:id/rollup-config/ — explicit save for the
 * aggregation policy radio. No optimistic update so the "Unsaved changes"
 * affordance is meaningful — the cache only updates on success.
 */
export function useSaveProgramRollupPolicy(
  programId: string,
): UseMutationResult<ProgramRollupConfig, Error, AggregationPolicy> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (aggregation_policy: AggregationPolicy) => {
      const res = await apiClient.patch<ProgramRollupConfig>(
        `/programs/${programId}/rollup-config/`,
        { aggregation_policy },
      );
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData<ProgramRollupConfig>(queryKey(programId), data);
    },
  });
}
