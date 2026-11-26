import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ScheduleFeasibility } from '@/api/types';

/** TanStack Query key for a project's schedule feasibility (#5106). */
export function scheduleFeasibilityKey(projectId: string) {
  return ['schedule', 'feasibility', projectId] as const;
}

/** True when `data` has the feasibility payload's shape (a catch-all mock does not). */
export function isScheduleFeasibility(data: unknown): data is ScheduleFeasibility {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.computable === 'boolean' && Array.isArray(d.cycle) && Array.isArray(d.tasks);
}

/**
 * Whether the server can compute this project's schedule
 * (`GET /projects/{id}/schedule/feasibility/`, #5106).
 *
 * The loop and its definition are server facts — the engine's own cycle check —
 * so the page never infers a loop from the links it holds. Refetched every 30 s
 * so a fixed link clears the banner without a reload; a response of another
 * shape is "no verdict", never a refusal.
 *
 * @param projectId - The project to check; the query is idle while undefined.
 */
export function useScheduleFeasibility(
  projectId: string | undefined,
): UseQueryResult<ScheduleFeasibility | null> {
  return useQuery({
    queryKey: scheduleFeasibilityKey(projectId ?? ''),
    queryFn: async ({ signal }) => {
      const { data } = await apiClient.get<unknown>(
        `/projects/${projectId}/schedule/feasibility/`,
        { signal },
      );
      return isScheduleFeasibility(data) ? data : null;
    },
    enabled: Boolean(projectId),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
