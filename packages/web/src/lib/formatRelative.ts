/**
 * Format a Date as a short relative-time string ("just now", "5m ago",
 * "3h ago", "2d ago") and fall back to "MMM D" for anything older than a week.
 *
 * Used by surfaces where the precise timestamp matters less than recency —
 * activity logs, forecast freshness signals, last-saved indicators.
 */
export function formatRelative(date: Date, now: number = Date.now()): string {
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
