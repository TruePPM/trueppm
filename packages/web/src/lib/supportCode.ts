import axios from 'axios';

/** Characters of the request id the code keeps — enough to find one log line. */
const REQUEST_ID_PREFIX = 8;

/**
 * A short code a person can read to support for a failed load.
 *
 * **Preferred: the request id.** The API's `RequestIDMiddleware` sets
 * `X-Request-ID` on every response and stamps the same id on every log record
 * as `request_id`, so `503-a1b2c3d4` (status + the id's first eight
 * characters) lets support grep straight to the failing request's log lines.
 * The web client calls the API same-origin (`baseURL: '/api/v1'`, proxied by
 * the web tier), so the header is readable. A deployment that serves the API
 * from another origin without exposing the header via CORS hides it from the
 * browser; the code then falls back, it does not break.
 *
 * **Fallback: status + UTC time.** With no readable id — no response at all
 * (`NET`), a client-side failure that was never a request (`APP`), or a
 * hidden header — the code is the status and the UTC time to the second, e.g.
 * `503-143207`. That narrows a log search; it is not a key.
 */
export function supportCode(error: unknown, at: Date = new Date()): string {
  if (!axios.isAxiosError(error)) return `APP-${utcTime(at)}`;
  const status = error.response?.status;
  if (status === undefined) return `NET-${utcTime(at)}`;
  const raw: unknown = error.response?.headers?.['x-request-id'];
  const id = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9]/g, '') : '';
  return id ? `${status}-${id.slice(0, REQUEST_ID_PREFIX)}` : `${status}-${utcTime(at)}`;
}

function utcTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
}
