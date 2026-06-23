import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Methodology } from '@/types';

/** `'ALL'` = no methodology filter; otherwise narrow to that preset (issue 564). */
export type MethodologyFilterValue = 'ALL' | Methodology;

/** Title-case labels shared by the filter chips and the per-row badges so the
 *  two never drift. The raw enum (`WATERFALL`/`AGILE`/`HYBRID`) reads as shouty
 *  on a dense picker. */
export const METHODOLOGY_LABEL: Record<Methodology, string> = {
  WATERFALL: 'Waterfall',
  AGILE: 'Agile',
  HYBRID: 'Hybrid',
};

const FILTERS: Array<{ value: MethodologyFilterValue; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'WATERFALL', label: METHODOLOGY_LABEL.WATERFALL },
  { value: 'AGILE', label: METHODOLOGY_LABEL.AGILE },
  { value: 'HYBRID', label: METHODOLOGY_LABEL.HYBRID },
];

/**
 * Single-select methodology facet filter for the add-project picker (issue 564),
 * built as an accessible radiogroup (rule 167/179, mirrors RiskSegmentedFilter).
 *
 * Roving tabindex: only the focused option is tabbable; Arrow / Home / End move
 * DOM focus but do NOT commit — selection applies on activation (click / Enter /
 * Space via the native button), so a keyboard user can scan without firing the
 * filter on every passing option. The active segment fills with `bg-brand-primary`
 * against the sunken container so selection is conveyed by fill, not text shade
 * alone (rule 179).
 */
export function MethodologyFilter({
  value,
  onChange,
}: {
  value: MethodologyFilterValue;
  onChange: (value: MethodologyFilterValue) => void;
}) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIdx = FILTERS.findIndex((f) => f.value === value);
  const [focusIdx, setFocusIdx] = useState(selectedIdx >= 0 ? selectedIdx : 0);
  useEffect(() => {
    if (selectedIdx >= 0) setFocusIdx(selectedIdx);
  }, [selectedIdx]);

  function moveFocus(next: number) {
    const i = Math.max(0, Math.min(FILTERS.length - 1, next));
    setFocusIdx(i);
    btnRefs.current[i]?.focus(); // focus only — commit happens on activation
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(focusIdx + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(focusIdx - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        e.preventDefault();
        moveFocus(FILTERS.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Filter by methodology"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="mt-3 flex shrink-0 items-center gap-1 self-start rounded-md border border-neutral-border bg-neutral-surface-sunken p-0.5"
    >
      {FILTERS.map(({ value: optionValue, label }, i) => {
        const active = value === optionValue;
        return (
          <button
            key={optionValue}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={i === focusIdx ? 0 : -1}
            onClick={() => onChange(optionValue)}
            className={[
              'inline-flex min-h-[44px] items-center justify-center rounded px-3 md:min-h-[32px]',
              'text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              active
                ? 'bg-brand-primary text-neutral-text-inverse'
                : 'text-neutral-text-secondary hover:bg-neutral-surface-raised hover:text-neutral-text-primary',
            ].join(' ')}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
