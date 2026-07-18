import { useId } from 'react';
import { pointInputOptions } from '@/lib/storyPoints';
import type { EstimationScale } from '@/api/types';

export interface StoryPointFieldProps {
  /** The project's resolved effective scale (drives the option list). */
  scale: EstimationScale;
  /** The stored integer, or null when unset. */
  value: number | null;
  /** Emits the chosen integer, or null for the empty "—" option. */
  onChange: (next: number | null) => void;
  /** Read-only (e.g. a points field locked on an active sprint). */
  disabled?: boolean;
  id?: string;
  /** Accessible name. Defaults to "Story points". */
  ariaLabel?: string;
  /** `md` = 44px touch target (mobile/drawer); `sm` = 32px desktop-compact. */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Scale-aware story-point picker (ADR-0510, #2027). A native `<select>` whose
 * options come from the project's effective {@link EstimationScale}:
 *
 * - Fibonacci / Linear → the allowed numbers.
 * - T-shirt → the size labels (XS…XL); the option *value* is the mapped integer,
 *   so `onChange` always emits the integer stored in `story_points` — there is no
 *   separate hidden field.
 * - Off-scale legacy value → preserved as a trailing `(N)` option so a scale
 *   switch is never destructive (see {@link pointInputOptions}).
 *
 * Native `<select>` gives keyboard traversal and the mobile OS picker for free.
 */
export function StoryPointField({
  scale,
  value,
  onChange,
  disabled = false,
  id,
  ariaLabel = 'Story points',
  size = 'sm',
  className = '',
}: StoryPointFieldProps) {
  const fallbackId = useId();
  const selectId = id ?? fallbackId;
  const options = pointInputOptions(scale, value);
  const heightClass = size === 'md' ? 'min-h-[44px] md:h-8' : 'h-8';

  return (
    <div className={`relative inline-block ${className || 'w-[220px]'}`}>
      <select
        id={selectId}
        value={value === null ? '' : String(value)}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className={`w-full ${heightClass} pl-2.5 pr-8 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary`}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option
            key={o.value}
            value={String(o.value)}
            // Off-scale legacy values read as "(N) — off scale" to a screen reader so
            // the parenthetical is not the only signal (WCAG 1.4.1).
            aria-label={o.offScale ? `${o.value} — off scale` : undefined}
          >
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-text-secondary"
        width="11"
        height="11"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  );
}
