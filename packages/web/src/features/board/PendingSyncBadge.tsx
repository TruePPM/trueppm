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
interface Props {
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

export function PendingSyncBadge({ compact = false, className }: Props) {
  return (
    <span
      role="status"
      className={[
        'inline-flex items-center gap-0.5 rounded-chip px-1 py-px text-xs font-medium',
        'bg-semantic-at-risk-bg text-semantic-at-risk',
        className ?? '',
      ].join(' ')}
      title="Move queued offline — it will sync when you reconnect."
      aria-label="Sync pending — this move will save when you reconnect."
    >
      <CloudOffGlyph />
      {!compact && <span>Pending</span>}
    </span>
  );
}
