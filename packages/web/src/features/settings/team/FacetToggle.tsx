import { Toggle } from '../components/Toggle';

/**
 * A single facet switch (Scrum Master / Product Owner) — ADR-0078 §H.
 *
 * A thin adapter over the shared settings `Toggle` so the knob, focus ring and
 * disabled/busy treatment never fork. Read-only mode renders the same control as a
 * non-interactive, dimmed state so viewers can still *see* who holds the facet.
 */

interface FacetToggleProps {
  on: boolean;
  ariaLabel: string;
  disabled?: boolean;
  pending?: boolean;
  onToggle: () => void;
}

export function FacetToggle({ on, ariaLabel, disabled, pending, onToggle }: FacetToggleProps) {
  return (
    <Toggle
      on={on}
      onChange={() => onToggle()}
      onLabel=""
      offLabel=""
      ariaLabel={ariaLabel}
      disabled={disabled}
      busy={pending}
    />
  );
}
