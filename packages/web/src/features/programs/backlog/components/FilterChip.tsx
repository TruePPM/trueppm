/**
 * Toolbar chip used for both the status facet (single-select radio) and the
 * Type / Tags dropdown triggers. Optional count badge and dropdown caret cover
 * all three toolbar shapes with one component (Phase 0 primitive).
 *
 * The host decides the semantics: pass `role="radio"` + `aria-checked` for the
 * status chips, or `aria-haspopup="menu"` + `aria-expanded` for the dropdown
 * triggers. Active styling is the brand-green selection treatment.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ChevronDownIcon } from '@/components/Icons';
import { FOCUS_RING } from './styles';

interface FilterChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  label: ReactNode;
  /** Optional mono count badge on the right (status chips). */
  count?: number;
  /** Brand-green selected/active treatment. */
  active?: boolean;
  /** Render a dropdown caret (Type / Tags triggers). */
  caret?: boolean;
}

export const FilterChip = forwardRef<HTMLButtonElement, FilterChipProps>(function FilterChip(
  { label, count, active = false, caret = false, className = '', ...rest },
  ref,
) {
  const tone = active
    ? 'border-brand-primary bg-brand-primary-light text-brand-primary-dark'
    : 'border-neutral-border bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised';
  return (
    <button
      ref={ref}
      type="button"
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium
        ${tone} ${FOCUS_RING} ${className}`}
      {...rest}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span
          className={`tppm-mono text-xs tabular-nums ${
            active ? 'text-brand-primary-dark' : 'text-neutral-text-secondary'
          }`}
        >
          {count}
        </span>
      )}
      {caret && <ChevronDownIcon aria-hidden="true" className="h-3 w-3" />}
    </button>
  );
});
