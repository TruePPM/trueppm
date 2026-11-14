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
    const asNumber = Number(header);
    if (Number.isFinite(asNumber) && asNumber >= 0) return Math.ceil(asNumber);
    const asDate = typeof header === 'string' ? Date.parse(header) : Number.NaN;
    if (!Number.isNaN(asDate)) return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
  }
  const body: unknown = err.response.data;
  if (body && typeof body === 'object') {
    const { wait, detail } = body as { wait?: unknown; detail?: unknown };
    if (typeof wait === 'number' && Number.isFinite(wait) && wait >= 0) return Math.ceil(wait);
    if (typeof detail === 'string') {
      const m = /available in (\d+) second/i.exec(detail);
      if (m) return Number(m[1]);
    }
  }
  return null;
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
