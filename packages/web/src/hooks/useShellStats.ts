import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { useProjectId } from '@/hooks/useProjectId';
import type { ShellStats } from '@/types';

export interface UseShellStatsResult {
  data: ShellStats | undefined;
  isLoading: boolean;
  error: Error | null;
}

interface StatusSummaryResponse {
  task_count: number;
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
    // `critical_count` (#1325); both ShellStats fields now derive from the one
    // surviving server field, which carried the identical value.
    criticalPathCount: r.critical_count,
    monteCarlop80: r.monte_carlo_p80,
    atRiskCount: r.at_risk_count,
    criticalCount: r.critical_count,
    atRiskTasks: r.at_risk_tasks,
    criticalTasks: r.critical_tasks,
    onlineUsers: 0,
    lastSaved: r.last_saved,
    recalculatedAt: r.recalculated_at,
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

  const { data, isLoading, error } = useQuery({
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

  return { data, isLoading, error };
}
