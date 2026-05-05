import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

interface RunOptions {
  n_simulations?: number;
}

/**
 * Trigger a Monte Carlo simulation run for a project.
 *
 * POSTs to `/projects/{pk}/monte-carlo/`, which executes synchronously
 * (~100 ms vectorised). On success, invalidates every cache key that holds
 * a latest-MC payload — both `monte-carlo-latest` (used by
 * `useMonteCarloResult` in the Schedule view, mobile card, and TopBar) and
 * `mc-latest` (used by the project Overview's Forecast widget). Without
 * invalidating both, running from the Schedule view leaves the Overview
 * stale, and vice versa.
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
      void qc.invalidateQueries({ queryKey: ['mc-latest', projectId] });
    },
  });
}
