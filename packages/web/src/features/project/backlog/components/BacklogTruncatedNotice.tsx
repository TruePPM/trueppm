/**
 * The "more stories than this page holds" notice for the product backlog (#2344).
 *
 * The grooming endpoint serializes a rank-ordered page of stories (health and epic
 * rollups still cover the whole backlog). Per packages/web rule 296 the notice carries
 * its own way past the cap — "Load next N" — on every surface that shows the capped
 * list (desktop grooming, mobile grooming, the sprint story picker).
 *
 * Neutral info treatment, not warning amber: nothing is wrong, the list is just long
 * (rules 242/283), and amber is already the "Backlog changed — reloaded" conflict
 * banner. A plain landmark, not `role="status"`: it mounts with the page content, so a
 * live region would not be announced anyway (rules 335/428).
 */
import { Button } from '@/components/Button';
import { InfoIcon } from '@/components/Icons';

export interface BacklogTruncatedNoticeProps {
  /** Stories currently loaded. */
  shown: number;
  /** Whole-backlog story count (server health). */
  total: number;
  /** Server page size; the notice renders nothing when it is 0 (an older server). */
  limit: number;
  onLoadMore: () => void;
  loading: boolean;
  className?: string;
}

export function BacklogTruncatedNotice({
  shown,
  total,
  limit,
  onLoadMore,
  loading,
  className = '',
}: BacklogTruncatedNoticeProps) {
  if (limit <= 0 || shown >= total) return null;
  const next = Math.min(limit, total - shown);
  return (
    <aside
      aria-label="Backlog truncated"
      data-testid="backlog-truncated-notice"
      className={`flex flex-wrap items-center gap-2 border-b border-neutral-border bg-neutral-surface-sunken px-6 py-2 text-xs text-neutral-text-secondary ${className}`}
    >
      <InfoIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        Showing the top {shown.toLocaleString()} of {total.toLocaleString()} stories by rank
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={onLoadMore}
        disabled={loading}
        aria-busy={loading || undefined}
      >
        {loading ? 'Loading…' : `Load next ${next.toLocaleString()}`}
      </Button>
    </aside>
  );
}
