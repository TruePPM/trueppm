import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AxiosError } from 'axios';

export interface HeatmapResource {
  id: string;
  name: string;
  initials: string;
  job_role: string;
  color: string;
  calendar_differs_from_project: boolean;
  util: number[]; // integer percent per week, same length as `weeks`
}

export interface HeatmapResponse {
  weeks: string[]; // ISO week labels e.g. "2026-W18"
  resources: HeatmapResource[];
}

export type HeatmapStatus = 'idle' | 'loading' | 'success' | 'schedule-not-run' | 'error';

export interface UseResourceHeatmapResult {
  data: HeatmapResponse | undefined;
  status: HeatmapStatus;
  error: Error | null;
}

/**
 * GET /api/v1/projects/{id}/resources/heatmap/
 * Weekly utilization heatmap for the team page (issue #217, ADR-0042).
 */
export function useResourceHeatmap(
  projectId: string | undefined,
  startIsoDate: string,
  weeks: 4 | 8 | 12 | 16,
  groupBy: 'role' | 'project' | 'none',
): UseResourceHeatmapResult {
  const query = useQuery<HeatmapResponse, AxiosError>({
    queryKey: ['resources-heatmap', projectId, startIsoDate, weeks, groupBy],
    queryFn: async () => {
      const res = await apiClient.get<HeatmapResponse>(
        `/projects/${projectId}/resources/heatmap/`,
        { params: { start: startIsoDate, weeks, group_by: groupBy } },
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
