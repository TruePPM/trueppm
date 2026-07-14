import { formatInstantDate, type ResolvedDatePrefs } from '@/lib/formatUserDateTime';

/**
 * Format a Date as a short relative-time string ("just now", "5m ago",
 * "3h ago", "2d ago") and fall back to a full date for anything older than a
 * week.
 *
 * Used by surfaces where the precise timestamp matters less than recency —
 * activity logs, forecast freshness signals, last-saved indicators.
 *
 * The `m/h/d ago` values are elapsed-time math and are timezone-independent, so
 * they never change with the user's preferences. Only the `>7d` fallback renders
 * a calendar date: when `prefs` is passed (#1953, ADR-0410) it is re-clocked to
 * the user's zone + format; when omitted, behavior is unchanged (browser-local
 * "MMM D") so no existing call site shifts.
 */
export function formatRelative(
  date: Date,
  now: number = Date.now(),
  prefs?: ResolvedDatePrefs,
): string {
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  if (prefs) return formatInstantDate(date.toISOString(), prefs);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
