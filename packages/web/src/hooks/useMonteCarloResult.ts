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
  // Server-computed CPM finish + per-percentile risk deltas + cumulative
  // S-curve (issue 987). The server owns these derivations so the UI renders them
  // instead of recomputing in the browser. Optional for resilience against
  // older cached payloads written before the fields existed. On the `/latest/`
  // from-history path (cache TTL expired) `confidence_curve` and
  // `histogram_buckets` are empty — only the percentiles, `cpm_finish`, and
  // `delta_vs_cpm` survive.
  cpm_finish?: string | null;
  delta_vs_cpm?: {
    p50: number | null;
    p80: number | null;
    p95: number | null;
  } | null;
  confidence_curve?: { date: string; pct: number }[];
  // Duration-sensitivity tornado (ADR-0140). Optional for resilience against
  // older cached payloads; empty on the from-history path (not persisted).
  sensitivity?: { task_id: string; index: number }[];
}

// issue 1231: the `/latest/` from-history fallback now returns the persisted
// `histogram_buckets`/`confidence_curve`/`sensitivity` (populated, not empty)
// when the run stored a distribution, so the histogram + tornado survive cache
// expiry. No client change is needed — `mapResponse` already maps populated
// arrays the same as the live-cache path (it dedupes/sorts buckets and maps
// sensitivity), so a from-history result yields a real chart instead of the
// empty-state prose. Legacy runs (no persisted distribution) still return empty
// arrays and fall through to the prompt.
function mapResponse(api: MonteCarloLatestResponse): MonteCarloResult {
  // Dedupe and sort histogram buckets by date. The API occasionally returns
  // multiple bucket entries for the same week (e.g. when the simulator emits
  // partial buckets that the aggregator was meant to merge), and the order is
  // not guaranteed to be ascending. Without this normalization the
  // MonteCarloDetailPanel "Confidence by date" rows show repeated dates and
  // out-of-sequence rows, and React warns about duplicate child keys.
  const merged = new Map<string, number>();
  for (const b of api.histogram_buckets) {
    merged.set(b.date, (merged.get(b.date) ?? 0) + b.count);
  }
  const buckets = Array.from(merged.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStart, count]) => ({ weekStart, count }));
  // Server-owned risk derivations (issue 987). Default defensively so a legacy cached
  // payload that predates these fields still maps to a well-formed result rather
  // than `undefined` deltas: cpmFinish → null, deltas → null, curve → []. An
  // empty curve is also the legitimate from-history state past the cache TTL.
  const deltaVsCpm = {
    p50: api.delta_vs_cpm?.p50 ?? null,
    p80: api.delta_vs_cpm?.p80 ?? null,
    p95: api.delta_vs_cpm?.p95 ?? null,
  };
  return {
    projectId: api.project_id,
    runs: api.runs,
    p50: api.p50,
    p80: api.p80,
    p95: api.p95,
    buckets,
    lastRunAt: api.last_run_at,
    cpmFinish: api.cpm_finish ?? null,
    deltaVsCpm,
    confidenceCurve: api.confidence_curve ?? [],
    sensitivity: (api.sensitivity ?? []).map((s) => ({ taskId: s.task_id, index: s.index })),
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
