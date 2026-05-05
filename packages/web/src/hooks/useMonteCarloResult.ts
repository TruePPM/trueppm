import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { apiClient } from '@/api/client';
import type { MonteCarloResult } from '@/types';

export interface UseMonteCarloResultReturn {
  data: MonteCarloResult | undefined;
  isLoading: boolean;
  error: Error | null;
}

// Wire shape returned by GET /projects/{pk}/monte-carlo/latest/. Distinct from
// the frontend type — keys use snake_case and `histogram_buckets` carries the
// pre-bucketed distribution under a `date` key per bucket.
interface MonteCarloLatestResponse {
  project_id: string;
  runs: number;
  p50: string;
  p80: string;
  p95: string;
  histogram_buckets: { date: string; count: number }[];
  // Captured at cache-write time on the backend (#335). Optional for
  // resilience against older cached payloads written before the field existed.
  last_run_at?: string;
}

function mapResponse(api: MonteCarloLatestResponse): MonteCarloResult {
  return {
    projectId: api.project_id,
    runs: api.runs,
    p50: api.p50,
    p80: api.p80,
    p95: api.p95,
    buckets: api.histogram_buckets.map((b) => ({ weekStart: b.date, count: b.count })),
    lastRunAt: api.last_run_at,
  };
}

/**
 * Fetch the latest Monte Carlo simulation result for a project.
 *
 * Calls `GET /projects/{pk}/monte-carlo/latest/`, which returns the cached
 * result of the most recent simulation (24h TTL). A 404 means no simulation
 * has been run since the cache last expired — we surface this as an empty
 * (`data: undefined`) state rather than an error, so callers can render a
 * "not run yet" placeholder without an error toast.
 */
export function useMonteCarloResult(projectId?: string): UseMonteCarloResultReturn {
  const query = useQuery({
    queryKey: ['monte-carlo-latest', projectId],
    queryFn: async () => {
      try {
        const res = await apiClient.get<MonteCarloLatestResponse>(
          `/projects/${projectId}/monte-carlo/latest/`,
        );
        return mapResponse(res.data);
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          // No simulation run yet — empty state, not an error. Return `null`
          // (React Query v5 disallows `undefined` from queryFn) and map to
          // `undefined` in the public hook return.
          return null;
        }
        throw err;
      }
    },
    enabled: !!projectId,
  });

  return {
    data: query.data ?? undefined,
    isLoading: query.isLoading,
    error: query.error,
  };
}
