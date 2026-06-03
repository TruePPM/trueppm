/**
 * A single facet switch (Scrum Master / Product Owner) — ADR-0078 §H.
 *
 * Mirrors the project-notification Toggle: a `role="switch"` button with the
 * sage/brand track when on. Read-only mode renders the same control as a
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
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      onClick={onToggle}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        on ? 'bg-brand-primary border-brand-primary' : 'bg-neutral-surface-sunken border-neutral-border',
        disabled && !pending ? 'opacity-50 cursor-not-allowed' : '',
        pending ? 'opacity-70 cursor-progress' : '',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
          on ? 'translate-x-3.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}
