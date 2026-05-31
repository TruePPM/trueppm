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
  // brand btn-primary — vivid sage fill, navy ink, sage-600 boundary
  primary:
    'bg-sage-500 text-navy-900 border border-sage-600 hover:bg-sage-600 ' +
    'dark:bg-sage-400 dark:text-navy-900 dark:border-sage-500 dark:hover:bg-sage-300',
  secondary:
    'bg-neutral-surface text-neutral-text-primary border border-neutral-border ' +
    'hover:bg-neutral-surface-sunken',
  ghost:
    'bg-transparent text-brand-primary border border-transparent ' +
    'hover:bg-brand-primary/10',
  danger:
    'bg-semantic-critical text-white border border-semantic-critical ' +
    'hover:opacity-90',
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
        'inline-flex items-center justify-center gap-1.5 rounded font-medium',
        'transition-colors focus-visible:outline-none focus-visible:ring-2',
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
