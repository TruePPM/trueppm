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
import { OfflinePendingBadge } from '@/components/OfflinePendingBadge';
import type { BlockerOpKind } from './offline/blockerQueue';

interface Props {
  /** Which queued write this represents — varies only the accessible copy. */
  kind: BlockerOpKind;
  /** Compact variant drops the visible text, keeping the glyph + accessible name. */
  compact?: boolean;
  className?: string;
}

export function BlockerPendingBadge({ kind, compact = false, className }: Props) {
  const label =
    kind === 'unblock'
      ? 'Unblock queued — it will save when you reconnect.'
      : 'Blocker flag queued — it will save when you reconnect.';
  return <OfflinePendingBadge label={label} compact={compact} className={className} />;
}
