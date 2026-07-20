import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

/**
 * Shared button (Design System v2.0, ADR-0103). One place owns the brand recipe
 * so the next rebrand is a single-file change rather than an 89-site sweep.
 *
 * Primary uses the brand `btn-primary` recipe — **sage-500 fill + navy-900 text**
 * (navy-on-sage = 6.8:1, brand-tested). This is the only fill/text pair that
 * stays AA at small sizes; white-on-sage drops below 4.5:1. Sage holds in dark
 * mode (sage-400 fill, navy text). The boundary needs `border-sage-600` because
 * sage-500 vs white is only ~2.9:1 (rule 1: border, not shadow).
 *
 * Focus ring is the standard rule-4 sage ring (`brand-primary` = sage-600/400),
 * with the `-offset-1` white gap so the ring reads on any surface.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-3 text-xs',
  md: 'h-8 px-3 text-[13px]',
  lg: 'h-10 px-4 text-sm',
};

const VARIANT: Record<ButtonVariant, string> = {
  // brand btn-primary — vivid sage fill, navy ink, sage-600 boundary. Hover
  // BRIGHTENS to sage-400 (not darkens to sage-600): navy-900 on sage-600 is
  // only 4.46:1 (marginally below the 4.5:1 AA floor for the 13px label),
  // while navy-900 on sage-400 is the same AA-safe pair the dark recipe already
  // ships as its fill — so light-mode hover now mirrors dark mode's own
  // brighten-on-hover (sage-400 → sage-300). (WCAG 1.4.3, #2196.)
  primary:
    'bg-sage-500 text-navy-900 border border-sage-600 hover:bg-sage-400 ' +
    'dark:bg-sage-400 dark:text-navy-900 dark:border-sage-500 dark:hover:bg-sage-300',
  secondary:
    'bg-neutral-surface text-neutral-text-primary border border-neutral-border ' +
    'hover:bg-neutral-surface-sunken',
  ghost:
    'bg-transparent text-brand-primary border border-transparent ' +
    'hover:bg-brand-primary/10',
  // danger — semantic-critical fill. The fill is mode-aware (#B91C1C light /
  // #F87171 dark via the CSS var), but white ink is not: white on the light-red
  // dark fill is only 2.77:1. `dark:text-navy-900` puts dark ink on the light
  // fill (4.9:1), mirroring the primary variant's dark treatment. Light mode is
  // unchanged (white on #B91C1C = 6.47:1). (WCAG 1.4.3, #2196; sibling of #2041.)
  danger:
    'bg-semantic-critical text-white dark:text-navy-900 ' +
    'border border-semantic-critical hover:opacity-90',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className = '', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[
        'inline-flex items-center justify-center gap-1.5 rounded-control font-medium',
        // `transition` (not `transition-colors`) so the active-press transform
        // animates alongside hover colors; the press is motion-safe-gated so
        // reduced-motion users get no movement (rule 70/180). v2 fluidity, ADR-0126.
        'transition duration-fast ease-brand motion-safe:active:translate-y-px',
        'focus-visible:outline-none focus-visible:ring-2',
        'focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary',
        'disabled:border-neutral-border/55 disabled:cursor-not-allowed',
        SIZE[size],
        VARIANT[variant],
        className,
      ].join(' ')}
      {...rest}
    />
  );
});
