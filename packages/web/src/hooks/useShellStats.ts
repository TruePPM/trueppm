// Stub hook — returns fixture data until real API hooks are wired in.
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
