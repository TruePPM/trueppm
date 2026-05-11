import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export type BurnVariant = 'burndown' | 'burnup' | 'combined';
export type BurnMetric = 'tasks' | 'points';

/** Single data point returned by the burndown / burnup API variants. */
export interface BurnPoint {
  date: string;
  actual: number;
  ideal: number;
  scope: number;
}

/** Single data point returned by the combined API variant. */
export interface CombinedPoint {
  date: string;
  remaining: number;
  completed: number;
  total: number;
  ideal: number;
}

export interface BurnChartResponse {
  chart_type: string;
  metric: string;
  since: string;
  until: string;
  series: BurnPoint[] | CombinedPoint[];
}

export function useBurnChart(
  projectId: string | null | undefined,
  variant: BurnVariant,
  metric: BurnMetric,
  since?: string,
  until?: string,
) {
  return useQuery({
    queryKey: ['burn-chart', projectId, variant, metric, since, until] as const,
    queryFn: async () => {
      const params = new URLSearchParams({ chart_type: variant, metric });
      if (since) params.set('since', since);
      if (until) params.set('until', until);
      const res = await apiClient.get<BurnChartResponse>(
        `/projects/${projectId}/burn/?${params.toString()}`,
      );
      return res.data;
    },
    enabled: !!projectId,
    staleTime: 5 * 60 * 1000,
  });
}
