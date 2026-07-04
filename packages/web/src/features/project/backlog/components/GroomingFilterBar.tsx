/**
 * Desktop grooming filter bar (issue 1044) — sits between the LegendStrip and
 * the table's column header, outside the `min-w-max` wrapper so it stays pinned
 * to the left and never scrolls with the wide table.
 *
 * Composition: title search · DoR-state facet (Idea/Refine/Ready, multi-select
 * OR) · "Unestimated only" checkbox · result count + Clear. Grooming a 50+ story
 * backlog across 8 epics is a scroll-and-squint exercise without it (the VoC gap
 * this closes). While any filter is active the caller disables drag-reorder —
 * the ADR-0110 write path persists the complete flattened order, so a filtered
 * subset would corrupt server-side ranks.
 */

import { DOR_FILTER_ORDER, DorFilterChip } from './GroomingFilterChips';
import { GroomingSearchInput } from './GroomingSearchInput';
import type { GroomingFilterControls } from '../hooks/useGroomingFilters';

interface GroomingFilterBarProps {
  controls: GroomingFilterControls;
  matchCount: number;
  totalCount: number;
}

export function GroomingFilterBar({ controls, matchCount, totalCount }: GroomingFilterBarProps) {
  const { filters, active, setQuery, toggleDor, setUnestimatedOnly, reset } = controls;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-border bg-neutral-surface px-6 py-2.5">
      <GroomingSearchInput
        value={filters.query}
        onChange={setQuery}
        resultCount={matchCount}
        totalCount={totalCount}
      />

      <div role="group" aria-label="Filter by readiness" className="flex items-center gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
          Readiness
        </span>
        {DOR_FILTER_ORDER.map((dor) => (
          <DorFilterChip
            key={dor}
            dor={dor}
            active={filters.dorStates.includes(dor)}
            onClick={() => toggleDor(dor)}
          />
        ))}
      </div>

      <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-neutral-text-secondary">
        <input
          type="checkbox"
          checked={filters.unestimatedOnly}
          onChange={(e) => setUnestimatedOnly(e.target.checked)}
          aria-label="Show only unestimated stories"
          className="h-4 w-4 accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
        Unestimated only
      </label>

      <div className="flex-1" />

      {active && (
        <div className="flex items-center gap-3">
          <span aria-live="polite" className="font-mono text-xs tabular-nums text-neutral-text-secondary">
            {matchCount} of {totalCount}
          </span>
          <button
            type="button"
            onClick={reset}
            className="text-xs font-semibold text-brand-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
