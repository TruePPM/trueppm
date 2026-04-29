import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AxiosError } from 'axios';

export interface ResourceSummary {
  avg_utilization_pct: number;
  over_allocated_count: number;
  over_allocated_weeks: string;
  under_utilized_count: number;
  under_utilized_names: string[];
  headcount: number;
  contractor_count: number;
}

export type SummaryStatus = 'idle' | 'loading' | 'success' | 'schedule-not-run' | 'error';

export interface UseResourceSummaryResult {
  data: ResourceSummary | undefined;
  status: SummaryStatus;
  error: Error | null;
}

/**
 * GET /api/v1/projects/{id}/resources/summary/
 * Four KPI aggregates for the Resources page header (issue #219, ADR-0042).
 */
export function useResourceSummary(projectId: string | undefined): UseResourceSummaryResult {
  const query = useQuery<ResourceSummary, AxiosError>({
    queryKey: ['resources-summary', projectId],
    queryFn: async () => {
      const res = await apiClient.get<ResourceSummary>(
        `/projects/${projectId}/resources/summary/`,
      );
      return res.data;
    },
    enabled: !!projectId,
    retry: (failureCount, error) => {
      const axErr = error as AxiosError;
      if (axErr.response?.status === 409 || axErr.response?.status === 403) return false;
      return failureCount < 2;
    },
  });

  if (!projectId) return { data: undefined, status: 'idle', error: null };
  if (query.isPending) return { data: undefined, status: 'loading', error: null };
  if (query.isError) {
    const axErr = query.error as AxiosError;
    if (axErr.response?.status === 409) return { data: undefined, status: 'schedule-not-run', error: null };
    return { data: undefined, status: 'error', error: query.error };
  }
  return { data: query.data, status: 'success', error: null };
}
