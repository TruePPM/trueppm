// Displays a non-blocking "Recalculating…" indicator in the toolbar while the
// CPM engine is recomputing. Wired to WebSocket scheduler events (issue #40);
// the `isVisible` prop is driven by the caller once that integration lands.

interface RecalculatingBadgeProps {
  isVisible: boolean;
}

export function RecalculatingBadge({ isVisible }: RecalculatingBadgeProps) {
  if (!isVisible) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label="CPM recalculation in progress"
      className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-neutral-border
        text-xs text-neutral-text-secondary"
    >
      <span
        aria-hidden="true"
        className="inline-block w-2.5 h-2.5 rounded-full border-2 border-current
          border-t-transparent animate-spin"
      />
      Recalculating…
    </span>
  );
}
