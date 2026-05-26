/**
 * Pure formatting utilities for the system-health surfaces.
 *
 * Kept in a separate module so they can be unit-tested without mounting any
 * React components.
 */

/**
 * Formats a duration in seconds as a compact human-readable string.
 *
 * Examples:
 *   0       → "0s"
 *   45      → "45s"
 *   90      → "1m30s"
 *   7320    → "2h2m"
 *   90000   → "1d1h"
 *
 * The output intentionally omits the smallest unit once a larger one is
 * present (e.g. hours suppress seconds), keeping labels short for table cells.
 */
export function formatAge(seconds: number): string {
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/**
 * Returns a short "Ns ago" label derived from a TanStack Query `dataUpdatedAt`
 * timestamp (milliseconds since epoch). Used by the overview page header to
 * give operators a live sense of data freshness.
 *
 * Returns "just now" for < 5 s, seconds up to 59 s, then "Nm ago", then
 * "Nh ago" — sufficient granularity given the 10 s poll interval.
 */
export function formatUpdatedAgo(dataUpdatedAt: number): string {
  if (dataUpdatedAt === 0) return '—';
  const elapsed = Math.floor((Date.now() - dataUpdatedAt) / 1000);
  if (elapsed < 5) return 'just now';
  if (elapsed < 60) return `${elapsed}s ago`;
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/**
 * Formats a byte count as a compact, base-1024 human-readable size.
 *
 * Examples:
 *   null      → "—"   (estimate unavailable)
 *   0         → "0 B"
 *   1536      → "1.5 KB"
 *   480000000 → "458 MB"
 *
 * Sizes shown in the retention editor are PostgreSQL estimates, so one decimal
 * place is plenty of precision. ``null`` renders as an em dash rather than a
 * misleading 0 (ADR-0090: bytes is best-effort).
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // <10 keeps one decimal (e.g. 1.5 KB); ≥10 rounds to whole (e.g. 458 MB).
  const formatted = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${formatted} ${units[unitIndex]}`;
}

/**
 * Returns a short "Ns ago" / "Nm ago" / "Nh ago" / "Nd ago" label for an ISO
 * timestamp string, or "—" when null. Used by the purge-run log.
 */
export function formatTimeAgo(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return '—';
  const elapsed = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (elapsed < 60) return `${elapsed}s ago`;
  return `${formatAge(elapsed)} ago`;
}
