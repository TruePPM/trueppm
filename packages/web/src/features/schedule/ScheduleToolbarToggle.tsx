/**
 * Single styled toggle button used inside a `role="group"` cluster in the
 * Schedule toolbar (#248). Mirrors `ZoomControl.tsx:11-40` exactly so the
 * toolbar stays visually consistent.
 *
 * The wrapping group is the caller's responsibility — this component is just
 * the per-button shell.
 */
export interface ScheduleToolbarToggleProps {
  pressed: boolean;
  onToggle: (next: boolean) => void;
  label: string;
  /** Optional accessible label override (defaults to `label`). */
  ariaLabel?: string;
}

export function ScheduleToolbarToggle({
  pressed,
  onToggle,
  label,
  ariaLabel,
}: ScheduleToolbarToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel ?? label}
      onClick={() => onToggle(!pressed)}
      className={[
        'px-3 h-7 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
        pressed
          ? 'bg-brand-primary text-neutral-text-inverse'
          : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
