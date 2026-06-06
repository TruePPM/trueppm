import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { apiClient } from '@/api/client';

/** Per-percentile day delta vs the immediately-previous (older) run. Positive =
 * the forecast slipped later (worse); negative = pulled earlier (better). A
 * field is null when either run lacked that percentile; the whole object is null
 * on the oldest/baseline row. */
export interface ForecastDelta {
  p50: number | null;
  p80: number | null;
  p95: number | null;
}

/** One persisted Monte Carlo run in the project forecast history (ADR-0109). */
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
  /** Run-author display name — present only for Admin/Owner; null otherwise so
   * forecast drift cannot become a named-individual signal for the team. */
  triggeredByName: string | null;
}

export interface UseMonteCarloHistoryReturn {
  data: MonteCarloRunHistoryItem[] | undefined;
  /** The OSS retention cap (newest-N per project), or null for unlimited. */
  cap: number | null;
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
}

interface MonteCarloHistoryResponse {
  results: MonteCarloRunWire[];
  cap: number | null;
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
 * finish-date forecast drift over time (ADR-0109, #961).
 *
 * Calls `GET /projects/{pk}/monte-carlo/history/`. A 404 (project gone) is
 * surfaced as an empty list rather than an error. Invalidated by
 * `useRunMonteCarlo` on a successful run so a new run prepends immediately.
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
        };
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          return { results: [], cap: null };
        }
        throw err;
      }
    },
    enabled: !!projectId,
  });

  return {
    data: query.data?.results,
    cap: query.data?.cap ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
