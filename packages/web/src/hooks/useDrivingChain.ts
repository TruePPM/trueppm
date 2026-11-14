import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ScheduleDrivingChain } from '@/api/types';
import { isDrivingChain } from '@/features/schedule/whyCritical/whyCriticalModel';

/** TanStack Query key for one task's driving chain (#4892). */
export function drivingChainKey(projectId: string, taskId: string) {
  return ['schedule', 'driving-chain', projectId, taskId] as const;
}

/**
 * Fetch the server's bounded driving chain for one task
 * (`GET /projects/{id}/schedule/driving-chain/?task_id=`, ADR-1381).
 *
 * The read is compute-heavy and throttled, so it never refetches on its own:
 * `staleTime: Infinity`, no interval, no window-focus refetch and no automatic
 * retry (a 429 shows a countdown and waits for the user). Only a schedule
 * recompute (the caller's job) or an explicit Refresh fetches again. Opening
 * another task changes the key, and TanStack aborts the previous request
 * through `signal`.
 *
 * @param projectId - Project the task belongs to.
 * @param taskId - The task to explain.
 * @param enabled - Mount-time gate; the section fetches only while it renders.
 */
export function useDrivingChain(
  projectId: string,
  taskId: string,
  enabled: boolean,
): UseQueryResult<ScheduleDrivingChain> {
  return useQuery({
    queryKey: drivingChainKey(projectId, taskId),
    queryFn: async ({ signal }) => {
      const { data } = await apiClient.get<unknown>(
        `/projects/${projectId}/schedule/driving-chain/`,
        { params: { task_id: taskId }, signal },
      );
      // A response of another shape (a proxy page, a catch-all mock) is an
      // error state, never a crash inside the drawer.
      if (!isDrivingChain(data)) throw new Error('Unexpected driving-chain response');
      return data;
    },
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
