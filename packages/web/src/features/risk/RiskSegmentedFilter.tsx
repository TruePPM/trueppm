import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { RISK_FILTERS, type RiskFilter } from './riskFilters';

/**
 * Single-select facet filter for the risk register (All/High/Unmitigated/Mine),
 * built as an accessible radiogroup (WCAG 2.1.1 / 4.1.2, rule 167).
 *
 * Roving tabindex: only the focused option is in the tab order. Arrow keys (and
 * Home/End) move DOM focus across the options but do NOT commit — the filter is
 * applied on activation (click / Enter / Space via the native button), per rule
 * 167. This keeps a keyboard user free to scan the segments without firing a
 * filter on every passing option.
 */
export function RiskSegmentedFilter({
  value,
  onChange,
  counts,
}: {
  value: RiskFilter;
  onChange: (value: RiskFilter) => void;
  /**
   * Live per-facet counts (issue 1230) rendered beside each segment label. The
   * count is decorative (aria-hidden) so the radio's accessible name stays the
   * bare label; the narrowed-table total is announced separately via the
   * register's aria-live status line. Absent → no counts shown.
   */
  counts?: Partial<Record<RiskFilter, number>>;
}) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIdx = RISK_FILTERS.findIndex((f) => f.value === value);
  // Roving focus index. Tracks the selection; arrows move it independently.
  const [focusIdx, setFocusIdx] = useState(selectedIdx >= 0 ? selectedIdx : 0);
  useEffect(() => {
    if (selectedIdx >= 0) setFocusIdx(selectedIdx);
  }, [selectedIdx]);

  function moveFocus(next: number) {
    const i = Math.max(0, Math.min(RISK_FILTERS.length - 1, next));
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
        moveFocus(RISK_FILTERS.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Filter risks"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="mb-2 flex shrink-0 items-center gap-1 self-start rounded-control border border-neutral-border bg-neutral-surface-sunken p-0.5"
    >
      {RISK_FILTERS.map(({ value: optionValue, label }, i) => {
        const active = value === optionValue;
        const count = counts?.[optionValue];
        return (
          <button
            key={optionValue}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex: only the focused option is tabbable.
            tabIndex={i === focusIdx ? 0 : -1}
            onClick={() => onChange(optionValue)}
            className={[
              'inline-flex min-h-[44px] items-center justify-center gap-1 rounded-chip px-3 md:min-h-[32px]',
              'text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
              'focus-visible:ring-offset-1',
              active
                ? 'bg-brand-primary text-neutral-text-inverse'
                : 'text-neutral-text-secondary hover:bg-neutral-surface-raised hover:text-neutral-text-primary',
            ].join(' ')}
          >
            {label}
            {count !== undefined && (
              <span
                aria-hidden="true"
                className={[
                  'tppm-mono tabular-nums',
                  active ? 'text-neutral-text-inverse/80' : 'text-neutral-text-disabled',
                ].join(' ')}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
