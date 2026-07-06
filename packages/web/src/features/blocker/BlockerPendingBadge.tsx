/**
 * "Will sync when online" badge for an offline-queued blocker write (ADR-0247).
 *
 * Mirrors the calm-offline vocabulary of the board `PendingSyncBadge` /
 * shell `SyncStatusBadge` (`bg-semantic-at-risk-bg` / `text-semantic-at-risk`,
 * cloud-off glyph) so a queued blocker reads as the same "saved, will sync"
 * state the rest of the app uses. It is a passive read-state label: the write is
 * already queued and will flush on reconnect — this just makes that visible, and
 * clears when the op flushes.
 *
 * Accessibility: `role="status"` plus the glyph and the "Pending" text (and the
 * `aria-label`) carry the meaning without relying on color alone (WCAG 1.4.1).
 */
import type { BlockerOpKind } from './offline/blockerQueue';

interface Props {
  /** Which queued write this represents — varies only the accessible copy. */
  kind: BlockerOpKind;
  /** Compact variant drops the visible text, keeping the glyph + accessible name. */
  compact?: boolean;
  className?: string;
}

function CloudOffGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M2 2l20 20" />
      <path d="M5.8 8.1A5 5 0 007 18h9a4 4 0 001.6-.3" />
      <path d="M20.4 14.5A4 4 0 0018 8h-1.3a7 7 0 00-3-3.2" />
    </svg>
  );
}

export function BlockerPendingBadge({ kind, compact = false, className }: Props) {
  const label =
    kind === 'unblock'
      ? 'Unblock queued — it will save when you reconnect.'
      : 'Blocker flag queued — it will save when you reconnect.';
  return (
    <span
      role="status"
      className={[
        'inline-flex items-center gap-0.5 rounded-chip px-1 py-px text-xs font-medium',
        'bg-semantic-at-risk-bg text-semantic-at-risk',
        className ?? '',
      ].join(' ')}
      title={label}
      aria-label={label}
    >
      <CloudOffGlyph />
      {!compact && <span>Pending</span>}
    </span>
  );
}
