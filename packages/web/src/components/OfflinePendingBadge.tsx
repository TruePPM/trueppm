/**
 * Shared "queued offline, will sync when you reconnect" chip (ADR-0220, ADR-0247).
 *
 * One glyph and chip for every offline-queued write surface (board card moves,
 * blockers), so an a11y or copy fix lands everywhere. It is a passive read-state
 * label: the write is already queued and flushes on reconnect.
 *
 * Accessibility: `role="status"` announces the queued state; the glyph plus the
 * "Pending" text (and `aria-label`) carry the meaning without relying on color
 * alone (WCAG 1.4.1). The caller supplies the accessible copy per mount.
 */
interface Props {
  /** Accessible name and tooltip, specific to the queued write. */
  label: string;
  /** Tooltip override when it should differ from the accessible name. */
  title?: string;
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

export function OfflinePendingBadge({ label, title, compact = false, className }: Props) {
  return (
    <span
      role="status"
      className={[
        'inline-flex items-center gap-0.5 rounded-chip px-1 py-px text-xs font-medium',
        'bg-semantic-at-risk-bg text-semantic-at-risk',
        className ?? '',
      ].join(' ')}
      title={title ?? label}
      aria-label={label}
    >
      <CloudOffGlyph />
      {!compact && <span>Pending</span>}
    </span>
  );
}
