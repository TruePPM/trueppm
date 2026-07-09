export type AvatarInitialsSize = 'sm' | 'md' | 'lg';

interface AvatarInitialsProps {
  /**
   * Pre-computed initials to display (1–2 characters). Callers keep their own
   * initials derivation — this component owns only the visual treatment, so
   * unifying it can never change what letters a given site shows.
   */
  initials: string;
  /** 'sm' = 24 px, 'md' = 28 px, 'lg' = 32 px (default). */
  size?: AvatarInitialsSize;
  /** Optional native tooltip. */
  title?: string;
  /** Extra utility classes (e.g. positioning nudges) merged onto the circle. */
  className?: string;
}

const SIZE_CLASSES: Record<AvatarInitialsSize, string> = {
  sm: 'h-6 w-6 text-xs',
  md: 'h-7 w-7 text-xs',
  lg: 'h-8 w-8 text-xs',
};

/**
 * Avatar-initials circle in the rule-143 canonical "sage fill + navy text"
 * treatment (`bg-brand-primary/15 text-neutral-text-primary`).
 *
 * The older sage-on-sage treatment (`text-brand-primary` on a sage tint) only
 * cleared WCAG AA on white cards and failed on the canvas / darker surfaces
 * (the Sidebar avatar debt in #1689). Navy text on the sage fill is AA in both
 * light and dark, so every avatar routes through this one component to keep the
 * treatment from drifting again (#1705).
 *
 * Decorative by default: the adjacent name text is the accessible label, so the
 * circle is `aria-hidden`.
 */
export function AvatarInitials({
  initials,
  size = 'lg',
  title,
  className,
}: AvatarInitialsProps) {
  return (
    <span
      aria-hidden="true"
      title={title}
      className={[
        'inline-flex shrink-0 items-center justify-center rounded-full bg-brand-primary/15 font-semibold text-neutral-text-primary',
        SIZE_CLASSES[size],
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {initials}
    </span>
  );
}
