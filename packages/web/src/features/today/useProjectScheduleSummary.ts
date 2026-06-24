import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Subset of `GET /projects/{id}/overview/` the Unified Today schedule strip reads
 * (ADR-0180). The full overview page (`ProjectOverviewPage`) reads more fields; the
 * Today strip only needs the schedule-health signal + the next milestone. Same
 * endpoint and query key (`['project-overview', id]`) so navigating Overview ↔ Today
 * reuses the cached response.
 */
export interface ProjectScheduleSummary {
  schedule_health: 'on_track' | 'at_risk' | 'critical' | 'unknown';
  spi: number | null;
  tasks_late_count: number;
  critical_task_count: number;
  total_tasks: number;
  complete_tasks: number;
  next_milestone: { id: string; name: string; date: string; percent_complete: number } | null;
}

export function useProjectScheduleSummary(
  projectId: string | undefined,
): UseQueryResult<ProjectScheduleSummary> {
  return useQuery<ProjectScheduleSummary>({
    queryKey: ['project-overview', projectId],
    queryFn: async () => {
      const res = await apiClient.get<ProjectScheduleSummary>(`/projects/${projectId}/overview/`);
      return res.data;
    },
    enabled: !!projectId,
  });
}
