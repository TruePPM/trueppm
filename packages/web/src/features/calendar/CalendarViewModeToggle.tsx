import { useRef, type KeyboardEvent } from 'react';
import type { CalViewMode } from './calendarUtils';

/**
 * Month | Week selector for the Calendar toolbar.
 *
 * A mutually exclusive view-mode choice, so it is the rule-179 segmented
 * control: a `radiogroup` of `radio` buttons with one roving tab stop, and
 * Arrow (wrapping) / Home / End moving AND committing the selection. The
 * handler is bound to the focusable radios, not the group (the group is not a
 * tab stop, and `jsx-a11y/interactive-supports-focus` rejects it there).
 *
 * The segments keep their own borders and a gap rather than sharing a clipped
 * pill: the rule-4 ring carries `ring-offset-1`, which `overflow-hidden` would
 * cut off, and on the sage active fill an un-offset ring is sage on sage.
 */

const MODES: ReadonlyArray<{ value: CalViewMode; label: string }> = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
];

export function CalendarViewModeToggle({
  value,
  onChange,
}: {
  value: CalViewMode;
  onChange: (mode: CalViewMode) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const current = MODES.findIndex((m) => m.value === value);
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = (current + 1) % MODES.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = (current - 1 + MODES.length) % MODES.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = MODES.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    onChange(MODES[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label="Calendar view mode" className="flex items-center gap-1">
      {MODES.map((m, i) => {
        const selected = m.value === value;
        return (
          <button
            key={m.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(m.value)}
            onKeyDown={onKeyDown}
            className={`
              border rounded h-7 px-3 text-xs font-medium
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface-raised
              ${
                selected
                  ? 'border-brand-primary bg-brand-primary text-neutral-text-inverse'
                  : 'border-neutral-border bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised'
              }
            `}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
