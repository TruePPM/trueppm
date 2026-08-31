import type { CSSProperties, KeyboardEvent } from 'react';
import { useRowMetrics } from '@/hooks/useRowHeight';
import { resolveUnitSegmentSize } from '../scheduleConstants';
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
 *
 * ## Sizing (#3212)
 *
 * Each segment is `resolveUnitSegmentSize(coarse)` square — 28px on a mouse,
 * 44px on a finger — and the number arrives through a CSS custom property rather
 * than a Tailwind class. Both halves of that matter and neither is style:
 *
 * - **Not a literal.** The shipped `h-7` was 28, which is `ROW_HEIGHT_FINE`
 *   written a second time (web rule 315(a)). It agreed with the row model by
 *   luck and could not follow it to 44, so the picker stayed at 28px on a tablet
 *   — under the touch floor, on the only pointer route to changing the unit.
 * - **Not a static class.** A Tailwind class is a string fixed at build time, so
 *   putting the resolved 44 in one is a module-scope capture of a runtime value
 *   (rule 315(b)). The custom property is emitted here in the inline `style` and
 *   read by an arbitrary-value class, which is rule 330(b)'s form. It is set on
 *   the **group**, not per button: custom properties inherit, so one emission
 *   feeds both radios and the two cannot be sized differently by an edit that
 *   touches only one branch.
 * - **Sized, not inset.** The box carries an explicit `w-`/`h-` rather than
 *   stretching to its container (rule 330(a) / 315's `inset-y-0` corollary) — the
 *   group's own 1px border sits inside its border box, so a stretched child would
 *   be 43px and would have missed a 44px floor while looking right.
 *
 * `useRowMetrics()` rather than a bare read of the binding: a hybrid laptop
 * folding shut flips `(pointer: coarse)` with no React state change behind it,
 * and only the subscription turns that into a re-render (rule 315(c)).
 */
export function DurationUnitPicker({
  value,
  onChange,
  disabled = false,
  'aria-describedby': describedBy,
}: Props) {
  const { coarse } = useRowMetrics();
  const segmentSize = resolveUnitSegmentSize(coarse);

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
      // Emitted once on the group and inherited by both radios (see the
      // docstring). Resolved for THIS pointer class, so the property always
      // states the size the control is actually presenting rather than carrying
      // a 44 the surface has decided not to use.
      style={{ '--unit-segment-size': `${segmentSize}px` } as CSSProperties}
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
              // Both axes from one variable — square by construction, so the
              // coarse value clears the floor on width and height together
              // rather than by two independent checks (#3212).
              'w-[var(--unit-segment-size)] h-[var(--unit-segment-size)]',
              'text-xs font-medium tppm-mono',
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
