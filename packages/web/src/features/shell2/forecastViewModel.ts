import type { MonteCarloResult } from '@/types';
import { describeWriteRefusal } from '@/lib/writeRefusal';

/**
 * What the shell-v2 Monte Carlo view shows. Every date and percentile is the
 * server's; this model only decides which state applies.
 *
 * - `loading` / `error`: the read is in flight or failed (rule 246: an error is
 *   never rendered as "not run yet").
 * - `not-run`: the read succeeded and the project has no forecast.
 * - `ready`: a forecast exists. `stale` is the server's `forecastStaleness`
 *   verdict (rule 415): anything but `'current'` replaces the "as of" claim with
 *   a rerun prompt. `'unknown'` counts as stale — a client that cannot tell must
 *   not say the forecast is fine.
 */
export type ForecastViewState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'not-run' }
  | { kind: 'ready'; result: MonteCarloResult; stale: boolean; asOf: string | null };

export interface ForecastQuery {
  data: MonteCarloResult | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function forecastViewState(q: ForecastQuery): ForecastViewState {
  if (q.error) return { kind: 'error' };
  if (q.isLoading) return { kind: 'loading' };
  const r = q.data;
  if (!r || !r.p50 || !r.p80 || !r.p95) return { kind: 'not-run' };
  return {
    kind: 'ready',
    result: r,
    stale: r.forecastStaleness !== 'current',
    asOf: r.lastRunAt ?? null,
  };
}

/** Copy for the stale state, keyed on the server's reason. Never claims a date moved. */
export function staleMessage(staleness: MonteCarloResult['forecastStaleness']): string {
  switch (staleness) {
    case 'projectChanged':
      return 'The project has changed since this forecast ran. Run it again to see the current plan.';
    case 'aged':
      return 'This forecast is old. Run it again to see the current plan.';
    default:
      return "We can't tell whether this forecast matches the current plan. Run it again to be sure.";
  }
}

/**
 * The inline text for a failed forecast run: the server's own refusal sentence,
 * with "Try again." appended only when replaying could succeed — a dependency
 * cycle or an archived project is not fixed by a second click.
 */
export function runRefusalText(error: unknown): string | null {
  const refusal = describeWriteRefusal(error, "Couldn't run the forecast.");
  if (!refusal) return null;
  return refusal.retryable ? `${refusal.message} Try again.` : refusal.message;
}
