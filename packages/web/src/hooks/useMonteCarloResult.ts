// Stub hook — returns fixture data until real API hooks are wired in.
// Replace the body with a real useQuery call; the return type is stable.
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import type { MonteCarloResult } from '@/types';

export interface UseMonteCarloResultReturn {
  data: MonteCarloResult | undefined;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Fetch the Monte Carlo simulation result for a project.
 *
 * @stub Returns fixture data until GET /projects/{id}/monte-carlo/ is wired.
 * Replace the body with a real useQuery call; the return type is stable.
 */
export function useMonteCarloResult(projectId?: string): UseMonteCarloResultReturn {
  void projectId; // stub — real hook will use this
  return { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
}
