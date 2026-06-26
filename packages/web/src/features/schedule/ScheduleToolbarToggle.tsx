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
  /**
   * When `true`, render an icon-only button: the label text is omitted from
   * the visible render but kept on `aria-label` and `title` (rule 114). Used
   * by the `md:` tier (rule 111) to collapse secondary toggles when the
   * viewport is too narrow for full labels. Defaults to `false`.
   *
   * The optional `icon` is required when `hideLabel` is `true` — otherwise
   * the button renders a single-letter fallback derived from `label`.
   */
  hideLabel?: boolean;
  /** Decorative glyph rendered in place of (or alongside) the label. */
  icon?: string;
}

export function ScheduleToolbarToggle({
  pressed,
  onToggle,
  label,
  ariaLabel,
  hideLabel = false,
  icon,
}: ScheduleToolbarToggleProps) {
  const fallbackIcon = label.trim().slice(0, 1).toUpperCase();
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel ?? label}
      title={hideLabel ? (ariaLabel ?? label) : undefined}
      onClick={() => onToggle(!pressed)}
      className={[
        'h-7 text-xs font-medium transition-colors',
        // Sizing must remain the same in both modes (rule 114) so the
        // toolbar height does not jitter when labels are hidden.
        hideLabel ? 'w-7 inline-flex items-center justify-center' : 'px-3',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
        pressed
          ? 'bg-brand-primary text-neutral-text-inverse'
          : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised',
      ].join(' ')}
    >
      {hideLabel ? <span aria-hidden="true">{icon ?? fallbackIcon}</span> : label}
    </button>
  );
}
