/**
 * Small provider tile for an external task source (#1422).
 *
 * A rounded square carrying the provider's two-letter initials — decorative
 * shorthand for "this row comes from Jira / GitHub / …". The accessible source
 * name is always rendered as adjacent text by the caller, so the mark itself is
 * `aria-hidden`. Colors are design-system tokens only (no brand hex): providers
 * are distinguished by their initials, not a bespoke brand color.
 */
interface Props {
  sourceType: string;
  /** Human label used to derive the initials; falls back to `sourceType`. */
  label?: string;
  className?: string;
}

// Known sources get the brand fill; an unrecognized source falls back to a
// neutral chip so a future/Enterprise source still renders sensibly.
const KNOWN_SOURCES = new Set(['jira', 'github', 'gitlab']);

export function SourceMark({ sourceType, label, className }: Props) {
  const initials = (label ?? sourceType).slice(0, 2).toUpperCase();
  const known = KNOWN_SOURCES.has(sourceType);
  return (
    <span
      aria-hidden="true"
      className={[
        'grid h-5 w-5 shrink-0 place-items-center rounded-[4px] text-[9px] font-bold leading-none tracking-tight',
        known
          ? 'bg-brand-primary text-neutral-text-inverse'
          : 'bg-neutral-surface-sunken text-neutral-text-secondary',
        className ?? '',
      ].join(' ')}
    >
      {initials}
    </span>
  );
}
