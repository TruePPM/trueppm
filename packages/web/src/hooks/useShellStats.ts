// TODO: The GET /projects/{id}/shell-stats/ endpoint does not exist in the API yet.
// Keeping the stub until the endpoint is implemented. See issue tracker for the
// backend task to add this endpoint to the ProjectViewSet.
import { FIXTURE_SHELL_STATS } from '@/fixtures/shellStats';
import type { ShellStats } from '@/types';

export interface UseShellStatsResult {
  data: ShellStats | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useShellStats(): UseShellStatsResult {
  return { data: FIXTURE_SHELL_STATS, isLoading: false, error: null };
}
