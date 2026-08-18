import type { KeyboardEvent } from 'react';
import type { DurationUnit } from './durationUnit';

const UNITS: ReadonlyArray<{ value: DurationUnit; short: string; long: string }> = [
  { value: 'days', short: 'd', long: 'Days' },
  { value: 'hours', short: 'h', long: 'Hours' },
];

interface Props {
  value: DurationUnit;
  onChange: (unit: DurationUnit) => void;
  disabled?: boolean;
  /** Ties the group to the duration input it belongs to, for screen readers. */
  'aria-describedby'?: string;
}

/**
 * The `d` / `h` unit toggle beside a duration input (#2975).
 *
 * A segmented radio group rather than a `<select>`: there are two values, and a
 * dropdown costs a click and hides the alternative behind it. It is a real
 * `radiogroup` so arrow keys move between the options — a two-button toggle that
 * only responds to Tab and Space reads as two unrelated buttons to a screen
 * reader, which is what the ARIA pattern exists to prevent.
 *
 * The short glyph is what shows; the full word is the accessible name, because
 * "d" announced on its own tells nobody anything.
 */
export function DurationUnitPicker({
  value,
  onChange,
  disabled = false,
  'aria-describedby': describedBy,
}: Props) {
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = UNITS.findIndex((u) => u.value === value);
    const next = e.key === 'ArrowRight' ? (i + 1) % UNITS.length : (i - 1 + UNITS.length) % UNITS.length;
    onChange(UNITS[next].value);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Duration unit"
      aria-describedby={describedBy}
      className="inline-flex items-center rounded-control border border-neutral-border overflow-hidden shrink-0"
    >
      {UNITS.map((unit) => {
        const selected = unit.value === value;
        return (
          <button
            key={unit.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={unit.long}
            disabled={disabled}
            // Only the selected option is in the tab order — the roving-tabindex
            // half of the radiogroup pattern, so Tab moves past the group rather
            // than through every option.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(unit.value)}
            // Arrow keys live on the radios, not the group: focus sits on the
            // selected option (roving tabindex), so that is where the key event
            // actually arrives.
            onKeyDown={onKeyDown}
            className={[
              'h-7 w-8 text-xs font-medium tppm-mono',
              'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset',
              'disabled:cursor-not-allowed disabled:text-neutral-text-disabled',
              selected
                ? 'bg-brand-primary text-neutral-surface'
                : 'bg-neutral-surface-raised text-neutral-text-secondary hover:text-neutral-text-primary',
            ].join(' ')}
          >
            {unit.short}
          </button>
        );
      })}
    </div>
  );
}
