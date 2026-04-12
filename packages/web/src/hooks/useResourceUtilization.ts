import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { UtilizationResponse } from '@/features/resource/resourceUtils';
import type { AxiosError } from 'axios';

export type UtilizationStatus = 'idle' | 'loading' | 'success' | 'schedule-not-run' | 'error';

export interface UseResourceUtilizationResult {
  data: UtilizationResponse | undefined;
  status: UtilizationStatus;
  error: Error | null;
}

export function useResourceUtilization(
  projectId: string | undefined,
  start: string,
  end: string,
): UseResourceUtilizationResult {
  const query = useQuery({
    queryKey: ['utilization', projectId, start, end],
    queryFn: async () => {
      const res = await apiClient.get<UtilizationResponse>(
        `/projects/${projectId}/utilization/`,
        { params: { start, end } },
      );
      return res.data;
    },
    enabled: !!projectId,
    retry: (failureCount, error) => {
      const axErr = error as AxiosError;
      // Don't retry 409 (schedule not run) or 403 (permission denied)
      if (axErr.response?.status === 409 || axErr.response?.status === 403) return false;
      return failureCount < 2;
    },
  });

  if (!projectId) {
    return { data: undefined, status: 'idle', error: null };
  }

  if (query.isLoading) {
    return { data: undefined, status: 'loading', error: null };
  }

  if (query.isError) {
    const axErr = query.error as AxiosError;
    if (axErr.response?.status === 409) {
      return { data: undefined, status: 'schedule-not-run', error: null };
    }
    return { data: undefined, status: 'error', error: query.error };
  }

  return { data: query.data, status: 'success', error: null };
}
