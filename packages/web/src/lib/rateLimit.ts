import axios from 'axios';

/** True when `err` is an HTTP 429 from the API's throttle layer. */
export function isRateLimited(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 429;
}

/**
 * Seconds the server asked the client to wait before retrying a 429, or null when
 * it named none. Reads the `Retry-After` header first (delta-seconds or an HTTP
 * date, RFC 9110 §10.2.3), then DRF's body — `wait` (a number) or the
 * "Expected available in N seconds." sentence in `detail`. Always rounds up so the
 * countdown never ends before the server would accept the retry.
 */
export function retryAfterSeconds(err: unknown): number | null {
  if (!axios.isAxiosError(err) || err.response?.status !== 429) return null;
  const header: unknown = err.response.headers?.['retry-after'];
  if (typeof header === 'string' || typeof header === 'number') {
    const trimmed = typeof header === 'string' ? header.trim() : header;
    // An empty header is Number('') === 0 — treat it as absent, not as "retry now".
    if (trimmed !== '') {
      const asNumber = Number(trimmed);
      if (Number.isFinite(asNumber) && asNumber >= 0) return usableWait(Math.ceil(asNumber));
      const asDate = typeof trimmed === 'string' ? Date.parse(trimmed) : Number.NaN;
      if (!Number.isNaN(asDate)) return usableWait(Math.ceil((asDate - Date.now()) / 1000));
    }
  }
  const body: unknown = err.response.data;
  if (body && typeof body === 'object') {
    const { wait, detail } = body as { wait?: unknown; detail?: unknown };
    if (typeof wait === 'number' && Number.isFinite(wait) && wait >= 0) {
      const w = usableWait(Math.ceil(wait));
      if (w !== null) return w;
    }
    if (typeof detail === 'string') {
      const m = /available in (\d+) second/i.exec(detail);
      if (m) return usableWait(Number(m[1]));
    }
  }
  return null;
}

/** Longest wait we will announce; an absurd header must not print "1440 minutes". */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 3600;

/** A zero or past wait names no wait at all (null, so callers fall back); a huge one is capped. */
function usableWait(seconds: number): number | null {
  if (seconds <= 0) return null;
  return Math.min(seconds, MAX_RATE_LIMIT_WAIT_SECONDS);
}

/** "in 12 seconds" / "in 1 minute 5 seconds" / "in a moment" when the wait is unknown. */
export function waitPhrase(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return 'in a moment';
  if (seconds < 60) return `in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const m = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return rest === 0 ? `in ${m}` : `in ${m} ${rest} ${rest === 1 ? 'second' : 'seconds'}`;
}
