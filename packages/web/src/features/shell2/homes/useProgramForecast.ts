import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import type { ProgramRollup } from '@/features/programs/ProgramOverviewPage';
import { forecastHeroState } from './programHomeModel';

/**
 * One program's forecast facts for a home: the rollup's `p80_completion` and the
 * saved Monte Carlo run of the project driving it (the S-curve and the commitment
 * delta). Same `['program-rollup', id]` key the program overview uses, so the two
 * share a cache entry.
 */
export function useProgramForecast(programId: string | undefined) {
  const rollup = useQuery<ProgramRollup>({
    queryKey: ['program-rollup', programId],
    queryFn: async () =>
      (await apiClient.get<ProgramRollup>(`/programs/${programId}/rollup/`)).data,
    enabled: Boolean(programId),
  });
  const hero = forecastHeroState({
    data: rollup.data,
    isLoading: rollup.isLoading,
    error: rollup.error,
  });
  const driverId = hero.kind === 'ready' ? (hero.driverProjectId ?? undefined) : undefined;
  const mc = useMonteCarloResult(driverId);
  return { hero, rollup, driverId, mc };
}
