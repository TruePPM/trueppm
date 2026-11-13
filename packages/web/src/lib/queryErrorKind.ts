/**
 * One reading of "why did this read fail" for `QueryErrorState` (#3874, #3621).
 *
 * A failed read is not one situation. A 403 will fail identically forever, so a
 * Retry button is a false promise; a 429 is a verdict about *now* and succeeds
 * if the client waits; everything else (5xx, network loss) is the generic case.
 * Collapsing them to one sentence is the rule-301 shape: a client-side reading
 * of a server verdict must never fall through to the neutral branch.
 *
 * Framework-free (only axios) so it is unit-testable without React.
 */
import axios from 'axios';

export type QueryErrorKind = 'forbidden' | 'throttled' | 'other';

export interface QueryErrorClassification {
  kind: QueryErrorKind;
  /** Seconds the server asked us to wait (`Retry-After`), clamped; only for `throttled`. */
  retryAfterSeconds: number | null;
}

/** A server hint longer than this is not a pause, it is an outage — stop auto-waiting on it. */
const MAX_AUTO_RETRY_SECONDS = 60;
/** Used when a 429 carries no usable `Retry-After`. */
export const DEFAULT_THROTTLE_RETRY_SECONDS = 5;

/** Parse the delta-seconds form of `Retry-After`; the HTTP-date form is ignored. */
function parseRetryAfter(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.ceil(seconds), MAX_AUTO_RETRY_SECONDS);
}

export function classifyQueryError(error: unknown): QueryErrorClassification {
  if (!axios.isAxiosError(error)) return { kind: 'other', retryAfterSeconds: null };
  const status = error.response?.status;
  if (status === 403) return { kind: 'forbidden', retryAfterSeconds: null };
  if (status === 429) {
    const headers = error.response?.headers as Record<string, unknown> | undefined;
    const hinted = parseRetryAfter(headers?.['retry-after']);
    return { kind: 'throttled', retryAfterSeconds: hinted ?? DEFAULT_THROTTLE_RETRY_SECONDS };
  }
  return { kind: 'other', retryAfterSeconds: null };
}
