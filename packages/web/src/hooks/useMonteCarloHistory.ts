import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { apiClient } from '@/api/client';
import type { MonteCarloResult } from '@/types';

/** Per-percentile day delta vs the immediately-previous (older) run. Positive =
 * the forecast slipped later (worse); negative = pulled earlier (better). A
 * field is null when either run lacked that percentile; the whole object is null
 * on the oldest/baseline row. */
export interface ForecastDelta {
  p50: number | null;
  p80: number | null;
  p95: number | null;
}

/** One persisted Monte Carlo run in the project forecast history (ADR-0175). */
export interface MonteCarloRunHistoryItem {
  id: string;
  takenAt: string;
  p50: string | null;
  p80: string | null;
  p95: string | null;
  cpmFinish: string | null;
  nSimulations: number;
  taskCount: number | null;
  delta: ForecastDelta | null;
  /** Run-author display name — present only for the resolved attribution
   * audience (ADR-0144); null otherwise so forecast drift cannot become a
   * named-individual signal for the team. */
  triggeredByName: string | null;
}

export interface UseMonteCarloHistoryReturn {
  data: MonteCarloRunHistoryItem[] | undefined;
  /** The retention cap (newest-N per project), or null for unlimited. */
  cap: number | null;
  /** False when the workspace has turned forecast history off (ADR-0144, issue 1232).
   * The endpoint returns 200 with an empty list and `enabled: false`; the UI
   * shows a "history is off" note rather than the list. Undefined while loading. */
  enabled: boolean | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

// Wire shape of GET /projects/{pk}/monte-carlo/history/ (snake_case).
interface MonteCarloRunWire {
  id: string;
  taken_at: string;
  p50: string | null;
  p80: string | null;
  p95: string | null;
  cpm_finish: string | null;
  n_simulations: number;
  task_count: number | null;
  delta: ForecastDelta | null;
  triggered_by_name: string | null;
  // Per-run distribution — null unless the request set ?expand=distribution
  // (issue 1231). Carries the same snake_case slice the /latest/ response holds.
  distribution?: PersistedDistributionWire | null;
}

interface MonteCarloHistoryResponse {
  results: MonteCarloRunWire[];
  cap: number | null;
  // ADR-0144 (issue 1232): absent on older payloads → treated as enabled.
  enabled?: boolean;
}

/** Persisted distribution slice — the same shape `/latest/` returns (issue 1231). */
interface PersistedDistributionWire {
  histogram_buckets: { date: string; count: number }[];
  confidence_curve?: { date: string; pct: number }[];
  sensitivity?: { task_id: string; index: number }[];
}

function mapItem(w: MonteCarloRunWire): MonteCarloRunHistoryItem {
  return {
    id: w.id,
    takenAt: w.taken_at,
    p50: w.p50,
    p80: w.p80,
    p95: w.p95,
    cpmFinish: w.cpm_finish,
    nSimulations: w.n_simulations,
    taskCount: w.task_count,
    delta: w.delta,
    triggeredByName: w.triggered_by_name,
  };
}

/**
 * Fetch the project Monte Carlo run history (newest-first), so a PM can read
 * finish-date forecast drift over time (ADR-0175, issue 961; config ADR-0144, issue 1232).
 *
 * Calls `GET /projects/{pk}/monte-carlo/history/`. A 404 (project gone) is
 * surfaced as an empty list rather than an error. The envelope carries
 * `enabled` (false when the workspace disabled history); older payloads omit it
 * and are treated as enabled. Invalidated by `useRunMonteCarlo` on a successful
 * run so a new run prepends immediately.
 */
export function useMonteCarloHistory(projectId?: string): UseMonteCarloHistoryReturn {
  const query = useQuery({
    queryKey: ['monte-carlo-history', projectId],
    queryFn: async () => {
      try {
        const res = await apiClient.get<MonteCarloHistoryResponse>(
          `/projects/${projectId}/monte-carlo/history/`,
        );
        return {
          results: res.data.results.map(mapItem),
          cap: res.data.cap,
          enabled: res.data.enabled ?? true,
        };
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          return { results: [], cap: null, enabled: true };
        }
        throw err;
      }
    },
    enabled: !!projectId,
  });

  return {
    data: query.data?.results,
    cap: query.data?.cap ?? null,
    enabled: query.data?.enabled,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/**
 * Map a persisted-distribution wire slice into the frontend `MonteCarloResult`
 * shape so it can drive `MonteCarloHistogram` directly. The run row already
 * carries the percentiles; this folds in the persisted distribution arrays
 * (issue 1231). Buckets are deduped/sorted to mirror `useMonteCarloResult`'s
 * `mapResponse` (the API can emit duplicate same-date buckets).
 */
export function buildResultFromRun(
  run: MonteCarloRunHistoryItem,
  distribution: PersistedDistributionWire | null | undefined,
): MonteCarloResult {
  const dist = distribution ?? { histogram_buckets: [] };
  const merged = new Map<string, number>();
  for (const b of dist.histogram_buckets ?? []) {
    merged.set(b.date, (merged.get(b.date) ?? 0) + b.count);
  }
  const buckets = Array.from(merged.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStart, count]) => ({ weekStart, count }));
  return {
    projectId: '',
    runs: run.nSimulations,
    // The histogram only reads p50/p80/p95 + buckets; a baseline run may carry
    // null percentiles, in which case the empty-state prose path renders.
    p50: run.p50 ?? '',
    p80: run.p80 ?? '',
    p95: run.p95 ?? '',
    buckets,
    lastRunAt: run.takenAt,
    cpmFinish: run.cpmFinish,
    deltaVsCpm: { p50: null, p80: null, p95: null },
    confidenceCurve: dist.confidence_curve ?? [],
    sensitivity: (dist.sensitivity ?? []).map((s) => ({ taskId: s.task_id, index: s.index })),
  };
}

export interface UseMonteCarloRunDistributionReturn {
  result: MonteCarloResult | undefined;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Fetch a single past run's persisted distribution and map it to a
 * `MonteCarloResult` for the histogram (issue 1231).
 *
 * Calls `GET /projects/{pk}/monte-carlo/history/?expand=distribution` (the list
 * endpoint with the heavier payload opted in) and picks `runId` out of the
 * results. The whole list is fetched rather than a per-run endpoint because the
 * history view is the only surface that serves the persisted distribution; the
 * query is keyed by `runId` so each expanded row caches independently and only
 * fires while `enabled`. A legacy run with no stored distribution maps to empty
 * buckets, which the histogram renders as the "run a fresh simulation" prompt.
 */
export function useMonteCarloRunDistribution(
  projectId: string | undefined,
  runId: string | undefined,
  enabled: boolean,
): UseMonteCarloRunDistributionReturn {
  const query = useQuery({
    queryKey: ['monte-carlo-run-distribution', projectId, runId],
    queryFn: async () => {
      const res = await apiClient.get<MonteCarloHistoryResponse>(
        `/projects/${projectId}/monte-carlo/history/`,
        { params: { expand: 'distribution' } },
      );
      const wire = res.data.results.find((r) => r.id === runId);
      if (!wire) return null;
      return buildResultFromRun(mapItem(wire), wire.distribution);
    },
    enabled: enabled && !!projectId && !!runId,
  });

  return {
    result: query.data ?? undefined,
    isLoading: query.isLoading,
    error: query.error,
  };
}
