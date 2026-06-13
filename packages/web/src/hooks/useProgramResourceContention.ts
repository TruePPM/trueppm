import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AllocationParams } from '@/hooks/useResourceAllocation';
import type { AllocationTask } from '@/features/resource/resourceUtils';
import type { AxiosError } from 'axios';

/**
 * A task span in the program contention response — the per-project allocation
 * endpoint shape (#85) plus the source-project attribution the program-scoped
 * endpoint (#1149) adds so the client can render the cross-project breakdown.
 */
export interface ProgramAllocationTask extends AllocationTask {
  project_id: string;
  project_name: string;
}

export interface ProgramAllocationResource {
  id: string;
  name: string;
  email: string;
  /** Decimal string, e.g. "1.00" */
  max_units: string;
  tasks: ProgramAllocationTask[];
}

export interface ProgramContentionResponse {
  program_id: string;
  window_start: string;
  window_end: string;
  resources: ProgramAllocationResource[];
}

/**
 * Status union for the program contention read. `forbidden` (HTTP 403) is split
 * out from `error` because resource data is Scheduler+ on the program (web-rule
 * 94 / the per-project gate) — the page renders a permission notice rather than a
 * generic error. `schedule-not-run` (409) is the "no member project scheduled
 * yet" state. The server is the authority; the client only branches on its code.
 */
export type ContentionStatus =
  | 'idle'
  | 'loading'
  | 'success'
  | 'schedule-not-run'
  | 'forbidden'
  | 'error';

export interface UseProgramResourceContentionResult {
  data: ProgramContentionResponse | undefined;
  status: ContentionStatus;
  error: Error | null;
}

/**
 * GET /api/v1/programs/{id}/resource-contention/ — per-resource task spans
 * aggregated across the program's member projects, each tagged with its source
 * project (#1149). The program counterpart to {@link useResourceAllocation}.
 *
 * Overallocation detection stays client-side (ADR-0031): callers feed the merged
 * spans to `detectOverallocatedAssignments` / `detectOverallocationWeekRange`.
 */
export function useProgramResourceContention(
  programId: string | undefined,
  params: AllocationParams = {},
): UseProgramResourceContentionResult {
  const query = useQuery({
    queryKey: ['program-resource-contention', programId, params],
    queryFn: async () => {
      const res = await apiClient.get<ProgramContentionResponse>(
        `/programs/${programId}/resource-contention/`,
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
    enabled: !!programId,
    retry: (failureCount, error) => {
      const axErr = error as AxiosError;
      const code = axErr.response?.status;
      if (code === 409 || code === 403 || code === 404) return false;
      return failureCount < 2;
    },
  });

  if (!programId) return { data: undefined, status: 'idle', error: null };
  if (query.isLoading) return { data: undefined, status: 'loading', error: null };
  if (query.isError) {
    const code = (query.error as AxiosError).response?.status;
    if (code === 409) return { data: undefined, status: 'schedule-not-run', error: null };
    if (code === 403) return { data: undefined, status: 'forbidden', error: null };
    return { data: undefined, status: 'error', error: query.error };
  }
  return { data: query.data, status: 'success', error: null };
}

/**
 * Returns a function that invalidates the contention query for a program. Wire
 * to WebSocket assignment_* events on member projects when live updates land.
 */
export function useInvalidateProgramContention(programId: string | undefined) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['program-resource-contention', programId] });
  };
}
