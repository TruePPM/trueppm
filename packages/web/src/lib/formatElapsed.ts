/**
 * Time-tracking display formatters for the live running timer (issue 1415, ADR-0185).
 *
 * The running clock is always *derived* from the server's authoritative
 * `started_at` (never accumulated client-side), so these take a plain second /
 * minute count and are pure — trivially testable and safe to call every tick.
 */

/**
 * Format a live elapsed duration as `h:mm:ss` (e.g. `5046` → `"1:24:06"`).
 *
 * Hours are unpadded (a timer rarely runs past single digits and the design's
 * header chip reads `1:24:06`); minutes and seconds are always two digits so
 * the mono chip does not jitter in width as they roll over. Negative or
 * non-finite input (a clock skew where `started_at` is briefly in the future)
 * clamps to `0:00:00` rather than rendering a nonsensical negative timer.
 */
export function formatElapsed(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Format a logged duration (whole minutes, as a stopped timer records) for the
 * confirmation toast — `25` → `"25m"`, `65` → `"1h 05m"`, `120` → `"2h 00m"`.
 *
 * Under an hour reads as bare minutes; an hour or more reads `Hh MMm` with the
 * minute part zero-padded so it scans like a clock. Guards against negative /
 * non-finite input (clamps to `"0m"`).
 */
export function formatLoggedMinutes(totalMinutes: number): string {
  const safe = Number.isFinite(totalMinutes) ? Math.max(0, Math.round(totalMinutes)) : 0;
  if (safe < 60) return `${safe}m`;
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}
