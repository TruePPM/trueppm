// Displays a non-blocking "Recalculating…" indicator in the toolbar while the
// CPM engine is recomputing. Wired to WebSocket scheduler events (issue #40);
// the `isVisible` prop is driven by the caller once that integration lands.

interface RecalculatingBadgeProps {
  isVisible: boolean;
  /**
   * Drop the label, keeping the spinner (#3076, ladder rung 12).
   *
   * The last concession the Schedule toolbar makes, and it is still a
   * *compaction*: state never demotes into a menu, because the reason the dates
   * look stale has to be visible at the moment they look stale. The accessible
   * name is unchanged at both densities, so the sentence a screen-reader user
   * hears does not shorten with the window.
   */
  compact?: boolean;
}

export function RecalculatingBadge({ isVisible, compact = false }: RecalculatingBadgeProps) {
  if (!isVisible) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label="CPM recalculation in progress"
      className={`flex shrink-0 items-center gap-1.5 rounded-chip border border-neutral-border
        text-xs text-neutral-text-secondary ${compact ? 'px-1.5 py-0.5' : 'px-2 py-0.5'}`}
    >
      <span
        aria-hidden="true"
        className="inline-block w-2.5 h-2.5 rounded-full border-2 border-current
          border-t-transparent animate-spin"
      />
      {!compact && 'Recalculating…'}
    </span>
  );
}
