/**
 * Per-card "pending sync" badge for offline-queued card-status moves (ADR-0220).
 *
 * Mirrors the calm-offline vocabulary of the shell `SyncStatusBadge`
 * (`bg-semantic-at-risk-bg` / `text-semantic-at-risk`, cloud-off glyph) in the
 * compact chip structure of `PendingAcceptanceChip`. It is a passive read-state
 * label: the move is already queued and will flush on reconnect — the badge just
 * makes that visible, and clears when the op flushes.
 *
 * Accessibility: `role="status"` announces the queued state; the glyph plus the
 * "Pending" text (and the `aria-label`) carry the meaning without relying on
 * color alone (WCAG 1.4.1).
 */
import { OfflinePendingBadge } from '@/components/OfflinePendingBadge';

interface Props {
  /** Compact variant drops the visible text, keeping the glyph + accessible name. */
  compact?: boolean;
  className?: string;
}

export function PendingSyncBadge({ compact = false, className }: Props) {
  return (
    <OfflinePendingBadge
      compact={compact}
      className={className}
      label="Sync pending — this move will save when you reconnect."
      title="Move queued offline — it will sync when you reconnect."
    />
  );
}
