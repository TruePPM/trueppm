import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AllocationResponse } from '@/features/resource/resourceUtils';
import type { AxiosError } from 'axios';

export type AllocationStatus = 'idle' | 'loading' | 'success' | 'schedule-not-run' | 'error';

export interface UseResourceAllocationResult {
  data: AllocationResponse | undefined;
  status: AllocationStatus;
  error: Error | null;
}

export interface AllocationParams {
  start?: string;
  end?: string;
  resource?: string[];
  status?: string[];
}

/**
 * GET /api/v1/projects/{id}/resource-allocation/ — fetch per-resource task spans.
 *
 * Invalidated automatically when the WebSocket broadcasts
 * assignment_created, assignment_updated, or assignment_deleted events.
 * Callers should call invalidateAllocation() from the WS event handler.
 *
 * Maps HTTP 409 → 'schedule-not-run' so the component renders the correct
 * empty state without inspecting raw HTTP codes.
 */
export function useResourceAllocation(
  projectId: string | undefined,
  params: AllocationParams = {},
): UseResourceAllocationResult {
  const query = useQuery({
    queryKey: ['resource-allocation', projectId, params],
    queryFn: async () => {
      const res = await apiClient.get<AllocationResponse>(
        `/projects/${projectId}/resource-allocation/`,
        {
          params: {
            ...(params.start && { start: params.start }),
            ...(params.end && { end: params.end }),
            ...(params.resource?.length && { resource: params.resource }),
            ...(params.status?.length && { status: params.status }),
          },
        },
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
  if (query.isLoading) return { data: undefined, status: 'loading', error: null };
  if (query.isError) {
    const axErr = query.error as AxiosError;
    if (axErr.response?.status === 409) {
      return { data: undefined, status: 'schedule-not-run', error: null };
    }
    return { data: undefined, status: 'error', error: query.error };
  }
  return { data: query.data, status: 'success', error: null };
}

/**
 * Returns a function that invalidates the resource-allocation query for a
 * project. Wire this to WebSocket assignment_* events.
 */
export function useInvalidateAllocation(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ['resource-allocation', projectId] });
  };
}
