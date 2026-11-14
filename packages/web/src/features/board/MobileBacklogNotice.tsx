interface MobileBacklogNoticeProps {
  /** Backlog items the phone layout is not showing. */
  count: number;
  /** Switch the board to the Queue layout, which lists the backlog on a phone. */
  onSwitchToQueue: () => void;
}

/**
 * Explains why the backlog is missing on a phone when the stored layout is an
 * explicit Rail or Drawer (#4305). The rail and drawer are desktop surfaces, so
 * the phone board shows status columns only; without this the backlog just
 * vanishes and reads as lost data. The stored layout is deliberately left alone
 * (#605): the one-tap action shows Queue for this visit to the board only, so the
 * stored Rail/Drawer still applies on desktop and on the next visit. Renders
 * nothing when there is nothing hidden.
 */
export function MobileBacklogNotice({ count, onSwitchToQueue }: MobileBacklogNoticeProps) {
  if (count <= 0) return null;
  return (
    <div
      role="status"
      data-testid="mobile-backlog-notice"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-border bg-neutral-surface-raised px-4 py-2"
    >
      <p className="m-0 text-xs text-neutral-text-secondary">
        Backlog hidden on phone ({count} {count === 1 ? 'item' : 'items'}) — switch to Queue to see
        it.
      </p>
      <button
        type="button"
        onClick={onSwitchToQueue}
        className="h-7 min-h-[44px] shrink-0 rounded-control border border-neutral-border bg-transparent px-3 text-xs font-medium text-neutral-text-primary hover:bg-neutral-surface focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        Switch to Queue
      </button>
    </div>
  );
}
