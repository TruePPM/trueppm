import axios from 'axios';

/**
 * A short code a person can read to support for a failed load: the HTTP status
 * (`NET` when no response arrived, `APP` for a client-side failure) and the UTC
 * time of the failure to the second, e.g. `503-143207`.
 *
 * Why these two parts: the API does not return a request id, so the only
 * things a support engineer can match against a server log line are the
 * status and the moment. Seconds-resolution UTC is precise enough to find the
 * line and short enough to read aloud. Not a secret, and not unique — it
 * narrows a search, it is not a key.
 */
export function supportCode(error: unknown, at: Date = new Date()): string {
  // `NET` = the request left but no response came back; `APP` = the failure was
  // not a request at all (a client exception), so there is no server line to find.
  const kind = axios.isAxiosError(error) ? String(error.response?.status ?? 'NET') : 'APP';
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `${kind}-${time}`;
}
