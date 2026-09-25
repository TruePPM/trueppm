import type { RefObject } from 'react';
import { useScheduleLegendCollapsed } from '@/hooks/useScheduleLegendCollapsed';

export interface ScheduleLegendToggleProps {
  /**
   * Exposes this button so `ScheduleLegend`'s own close control can hand
   * focus back here when it unmounts itself (#3614) — the same "own control
   * removed the focused element, so return focus to what reopens it" pattern
   * `displayTriggerRef` documents for the how-to bar (#3134). Optional: at a
   * narrow toolbar width this button demotes into the `···` overflow menu
   * and does not exist to receive focus, which is a safe no-op, not a bug.
   */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * Toolbar "Legend" toggle for the Schedule (Gantt) view (#3614).
 *
 * Shows/hides the floating `ScheduleLegend` overlay. Both this button and the
 * legend panel's own close control read and write the SAME
 * `useScheduleLegendCollapsed` state, so there is exactly one source of
 * truth for whether the legend is open — the button cannot claim "open" while
 * the panel is closed, or vice versa.
 *
 * A toggle, so `aria-pressed` carries the state and the accessible name stays
 * constant — WAI-ARIA wants a toggle's label stable across its states, the
 * same convention `TaskListRow`'s milestone toggle documents.
 */
export function ScheduleLegendToggle({ triggerRef }: ScheduleLegendToggleProps) {
  const { collapsed, toggle } = useScheduleLegendCollapsed();
  const open = !collapsed;

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={toggle}
      aria-pressed={open}
      data-testid="schedule-legend-toggle"
      className={`border rounded-control h-7 px-3 text-xs font-medium flex-shrink-0
        focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
        hover:border-brand-primary hover:text-brand-primary ${
          open
            ? 'border-brand-primary text-brand-primary bg-neutral-surface-sunken'
            : 'border-neutral-border text-neutral-text-primary'
        }`}
    >
      Legend
    </button>
  );
}
