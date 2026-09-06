import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Methodology } from '@/types';

/** `'ALL'` = no methodology filter; otherwise narrow to that preset (issue 564). */
export type MethodologyFilterValue = 'ALL' | Methodology;

/** Sentinel for the opt-in "deviates from the inherited default" facet (#3295). */
export const DEVIATES = 'DEVIATES';

/**
 * The value union a mount that opts into the deviation facet works in.
 *
 * `MethodologyFilterValue` is deliberately NOT widened to include it: the two
 * pre-existing mounts (`ProgramListPage`, `AddProjectToProgramModal`) narrow with
 * `p.methodology === value`, which a wider union would make silently unsatisfiable
 * — it filters every row out rather than failing to compile. Opting in is therefore
 * a per-mount prop plus a per-mount value type, not a fifth entry in the
 * module-level constant: "deviates from the program default" names nothing on a
 * program list or on a candidate project that is not in the program yet (#3295, D31).
 *
 * The `deviationOption` prop is typed against `V` so the pairing is enforced rather
 * than asserted — a mount that has not widened its value type cannot pass it.
 */
export type MethodologyDeviationFilterValue = MethodologyFilterValue | typeof DEVIATES;

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

interface Option {
  value: MethodologyDeviationFilterValue;
  label: string;
  count?: number;
}

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
 *
 * Three opt-in extensions exist for the program-projects matrix (#3295, D31/D40):
 * per-option `counts`, a fifth `deviationOption`, and `collapseFacets` for the
 * narrow-viewport card list, where the three method facets are a desktop scan tool
 * and the deviation comparison is the one worth a 44px target. A zero-count option
 * renders `aria-disabled` rather than `disabled` so it keeps its place in the
 * roving order — "I checked, and none" is a different statement from "this control
 * is missing", and a `disabled` button says neither because it cannot be reached.
 */
export function MethodologyFilter<
  V extends MethodologyDeviationFilterValue = MethodologyFilterValue,
>({
  value,
  onChange,
  counts,
  deviationOption,
  collapseFacets = false,
}: {
  value: V;
  onChange: (value: V) => void;
  /** Per-option row counts. Omit for a bare filter (the two pre-#3295 mounts). */
  counts?: Partial<Record<MethodologyFilterValue, number>>;
  /** Opt in to the fifth "deviates from …" option. Omit it and nothing renders —
   *  which is the correct state when no row carries an inherited value to compare
   *  against, because a disabled zero would claim a check that never happened.
   *
   *  Resolves to `never` unless `V` includes `DEVIATES`, so a mount that has not
   *  widened its value type gets a compile error instead of an `onChange` that is
   *  handed a value its own handler is typed to reject. */
  deviationOption?: typeof DEVIATES extends V ? { label: string; count: number } : never;
  /** Narrow viewport: keep only All + the deviation option (D40). */
  collapseFacets?: boolean;
}) {
  const options = useMemo<Option[]>(() => {
    const base: Option[] = FILTERS.filter(
      (f) => !collapseFacets || f.value === 'ALL',
    ).map((f) => ({ value: f.value, label: f.label, count: counts?.[f.value] }));
    if (!deviationOption) return base;
    return [
      ...base,
      { value: DEVIATES, label: deviationOption.label, count: deviationOption.count },
    ];
  }, [counts, deviationOption, collapseFacets]);

  // The caller opted into `DEVIATES` by passing `deviationOption`, but the type
  // parameter cannot express that pairing — one assertion, at the single seam.
  const emit = onChange as unknown as (v: MethodologyDeviationFilterValue) => void;

  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIdx = options.findIndex((f) => f.value === value);
  const [focusIdx, setFocusIdx] = useState(selectedIdx >= 0 ? selectedIdx : 0);
  // Re-sync on the option SET as well as on the selection. When the set shrinks
  // under a live selection — the narrow collapse, or the deviation option leaving
  // because a refetch dropped the inherited value — `selectedIdx` goes to -1, and a
  // stale `focusIdx` past the new end evaluates `tabIndex={-1}` on EVERY option,
  // stripping the whole radiogroup from the tab order while a filter is still in
  // force. Falling back to 0 keeps a way in.
  useEffect(() => {
    setFocusIdx(selectedIdx >= 0 ? selectedIdx : 0);
  }, [selectedIdx, options.length]);

  function moveFocus(next: number) {
    const i = Math.max(0, Math.min(options.length - 1, next));
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
        moveFocus(options.length - 1);
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
      className="mt-3 flex shrink-0 items-center gap-1 self-start rounded-control border border-neutral-border bg-neutral-surface-sunken p-0.5"
    >
      {options.map(({ value: optionValue, label, count }, i) => {
        const active = value === optionValue;
        // An option matching nothing stays reachable and states its zero (§C).
        const empty = count === 0 && optionValue !== 'ALL';
        return (
          <button
            key={optionValue}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={empty || undefined}
            // The count belongs INSIDE the accessible name — "Deviates from
            // default, 12" is one label, not a label plus an orphan number.
            aria-label={count == null ? undefined : `${label}, ${count}`}
            tabIndex={i === focusIdx ? 0 : -1}
            onClick={() => {
              if (!empty) emit(optionValue);
            }}
            className={[
              'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-control px-3 md:min-h-[32px]',
              'text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              active ? 'bg-brand-primary text-neutral-text-inverse' : 'text-neutral-text-secondary',
              // A soft-disabled option is kept reachable in order to be READ, so it
              // takes no opacity multiplier — and it must not light up on hover and
              // then no-op on click.
              !active && !empty
                ? 'hover:bg-neutral-surface-raised hover:text-neutral-text-primary'
                : '',
              empty && !active ? 'cursor-not-allowed' : '',
            ].join(' ')}
          >
            {label}
            {count != null && <span className="tppm-mono text-xs">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
