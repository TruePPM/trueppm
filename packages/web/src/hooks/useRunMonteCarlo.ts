import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

interface RunOptions {
  n_simulations?: number;
}

/**
 * Trigger a Monte Carlo simulation run for a project.
 *
 * POSTs to `/projects/{pk}/monte-carlo/`, which executes synchronously
 * (~100 ms vectorised). On success, invalidates the `monte-carlo-latest`
 * cache so every consumer of `useMonteCarloResult` (Project Overview's
 * Forecast widget, the Schedule MC row, the mobile card, and the TopBar
 * P80 pill) refetches in lockstep.
 *
 * Also invalidates `monte-carlo-history` so the new run prepends to the forecast
 * drift history (ADR-0109, #961) without a manual refresh.
 */
export function useRunMonteCarlo(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (opts: RunOptions = {}) => {
      if (!projectId) throw new Error('projectId is required to run Monte Carlo');
      await apiClient.post(`/projects/${projectId}/monte-carlo/`, opts);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['monte-carlo-latest', projectId] });
      void qc.invalidateQueries({ queryKey: ['monte-carlo-history', projectId] });
    },
  });
}
