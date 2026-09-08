import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { useProjectId } from '@/hooks/useProjectId';
import type { HealthBandSource, ShellStats } from '@/types';
import type { HealthBand } from '@/lib/healthBand';

export interface UseShellStatsResult {
  data: ShellStats | undefined;
  /**
   * First load of this project only. TanStack's `isLoading` is
   * `isPending && isFetching`, so it is FALSE on a background refetch of cached
   * data — the chip must not pulse every time the 30s `staleTime` lapses. Do not
   * substitute `isFetching` here.
   */
  isLoading: boolean;
  error: Error | null;
  /**
   * Re-run just this request. `undefined` data means "in flight" AND "failed",
   * so a consumer that distinguishes the two (`HealthCluster`, #3525) needs a way
   * to recover from the second without reloading the whole app (rule 246).
   */
  refetch: () => void;
}

/**
 * The `GET /projects/{id}/status-summary/` body.
 *
 * `last_saved` and `recalculated_at` are real server values (#2903) but are not
 * mapped onto `ShellStats`: nothing in the shell renders them. They stay declared
 * here so the interface still describes the endpoint rather than only the subset
 * this hook happens to read.
 */
interface StatusSummaryResponse {
  task_count: number;
  /**
   * The project's health band, decided by the server (#3501). It folds in the
   * manual `Project.health` override, which the two counts below cannot see —
   * so this value is read, never re-derived from `at_risk_count` /
   * `critical_count`.
   */
  health_band: HealthBand;
  /**
   * Which of the server's two branches produced `health_band` (#3525): the PM's
   * manual report, or the counts below. Also not derivable here — a report that
   * agrees with the counts is indistinguishable from no report at all, so
   * comparing the band against the counts misses it exactly where nothing looks
   * wrong.
   */
  health_band_source: HealthBandSource;
  monte_carlo_p80: string | null;
  at_risk_count: number;
  critical_count: number;
  at_risk_tasks: { id: string; name: string; wbs: string }[];
  critical_tasks: { id: string; name: string; wbs: string }[];
  last_saved: string | null;
  recalculated_at: string | null;
}

function toShellStats(r: StatusSummaryResponse): ShellStats {
  return {
    taskCount: r.task_count,
    // `critical_path_count` was dropped from the API as an exact alias of
    // `critical_count` (issue 1325); both ShellStats fields now derive from the one
    // surviving server field, which carried the identical value.
    criticalPathCount: r.critical_count,
    monteCarlop80: r.monte_carlo_p80,
    healthBand: r.health_band,
    healthBandSource: r.health_band_source,
    atRiskCount: r.at_risk_count,
    criticalCount: r.critical_count,
    atRiskTasks: r.at_risk_tasks,
    criticalTasks: r.critical_tasks,
    onlineUsers: 0,
  };
}

/**
 * Fetch project health summary from GET /projects/{id}/status-summary/.
 *
 * Returns task counts, at-risk/critical signals, and schedule recency data
 * in a single request so the TopBar avoids waterfall fetches.
 */
export function useShellStats(): UseShellStatsResult {
  const projectId = useProjectId();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['shellStats', projectId],
    queryFn: async () => {
      const resp = await apiClient.get<StatusSummaryResponse>(
        `/projects/${projectId}/status-summary/`,
      );
      return toShellStats(resp.data);
    },
    enabled: Boolean(projectId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  return { data, isLoading, error, refetch: () => void refetch() };
}
