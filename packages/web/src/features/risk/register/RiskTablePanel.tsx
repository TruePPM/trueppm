import type { ReactNode } from 'react';
import type { Risk } from '@/api/types';
import { EmptyState } from '@/components/EmptyState';
import { QueryErrorState } from '@/components/QueryErrorState';
import { Button } from '@/components/Button';
import { CloseIcon, RiskIcon } from '@/components/Icons';
import { RiskSegmentedFilter } from '../RiskSegmentedFilter';
import {
  RISK_FILTERS,
  nextSeveritySort,
  severityAriaSort,
  type RiskFilter,
  type SeveritySort,
} from '../riskFilters';
import type { SelectedCell } from '../RiskMatrix';

interface RiskTablePanelProps {
  risks: Risk[];
  displayRisks: Risk[];
  isLoading: boolean;
  error: Error | null;
  canImport: boolean;
  onOpenImport: () => void;
  onCreate: () => void;
  filter: RiskFilter;
  onFilterChange: (next: RiskFilter) => void;
  filterCounts: Record<string, number>;
  /** Copy for the 'facet matched nothing' state, keyed by segment. */
  filterEmptyCopy: Record<Exclude<RiskFilter, 'all'>, string>;
  selectedCell: SelectedCell | null;
  onClearCell: () => void;
  isFiltered: boolean;
  onClearAllFilters: () => void;
  severitySort: SeveritySort;
  onSeveritySortChange: (next: SeveritySort) => void;
  newestSort: boolean;
  onNewestSortChange: (next: boolean) => void;
  /** Renders one table row; owned by the register so the row keeps its key. */
  renderRow: (risk: Risk) => ReactNode;
}

/**
 * The register's right column: the four load states (loading / error / empty /
 * populated), the segment facet with its removable active-facet chips, and the
 * table itself.
 */
export function RiskTablePanel({
  risks,
  displayRisks,
  isLoading,
  error,
  canImport,
  onOpenImport,
  onCreate,
  filter,
  onFilterChange,
  filterCounts,
  filterEmptyCopy,
  selectedCell,
  onClearCell,
  isFiltered,
  onClearAllFilters,
  severitySort,
  onSeveritySortChange,
  newestSort,
  onNewestSortChange,
  renderRow,
}: RiskTablePanelProps) {
  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {/* Loading */}
      {isLoading && (
        <div className="flex flex-col gap-1" aria-label="Loading risks" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse border border-neutral-border"
              aria-hidden="true"
            />
          ))}
        </div>
      )}

      {/* Error */}
      {!isLoading && error && <QueryErrorState message="Failed to load risks." />}

      {/* Empty — no risks at all */}
      {!isLoading && !error && risks.length === 0 && (
        <RegisterEmptyState canImport={canImport} onCreate={onCreate} onOpenImport={onOpenImport} />
      )}

      {/* Table */}
      {!isLoading && !error && risks.length > 0 && (
        <>
          {/* Segment filter — single-select facet (All/High/Unmitigated/Mine).
              A radiogroup (pick exactly one) with roving-tabindex keyboard
              nav, not a tablist (it filters one list, doesn't swap panels). */}
          <RiskSegmentedFilter value={filter} onChange={onFilterChange} counts={filterCounts} />

          {/* Active-facet status chip — renders a removable token per active
              facet (segment and/or matrix cell), each independently
              clearable, plus a Clear all reset. */}
          <RiskActiveFacetChips
            isFiltered={isFiltered}
            filter={filter}
            onClearFilter={() => onFilterChange('all')}
            selectedCell={selectedCell}
            onClearCell={onClearCell}
            onClearAllFilters={onClearAllFilters}
            shownCount={displayRisks.length}
            totalCount={risks.length}
          />

          {/* Filtered-empty — risks exist but none match the active facets */}
          {displayRisks.length === 0 && (
            <FilteredEmpty
              selectedCell={selectedCell}
              filter={filter}
              filterEmptyCopy={filterEmptyCopy}
              onClearAllFilters={onClearAllFilters}
            />
          )}

          {displayRisks.length > 0 && (
            <div className="flex-1 overflow-auto rounded-card border border-neutral-border bg-neutral-surface">
              {/* min-w-max lets the table keep its intrinsic column widths and
                  scroll horizontally inside this wrapper on a phone, rather than
                  squishing/clipping at 375px (rule 102a). */}
              <table className="w-full min-w-max text-sm border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-neutral-surface-raised border-b border-neutral-border">
                    <th
                      scope="col"
                      className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[88px]"
                    >
                      ID
                    </th>
                    <th
                      scope="col"
                      className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide"
                    >
                      Risk
                    </th>
                    <th
                      scope="col"
                      className="text-center px-3 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-10"
                    >
                      P
                    </th>
                    <th
                      scope="col"
                      className="text-center px-3 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-10"
                    >
                      I
                    </th>
                    <th
                      scope="col"
                      aria-sort={newestSort ? 'none' : severityAriaSort(severitySort)}
                      className="px-4 py-3 w-[148px]"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          // Column sort and Newest are mutually exclusive.
                          onNewestSortChange(false);
                          onSeveritySortChange(nextSeveritySort(severitySort));
                        }}
                        className="inline-flex items-center gap-1 font-medium text-neutral-text-secondary
                        hover:text-neutral-text-primary text-xs uppercase tracking-wide
                        focus:outline-none focus:ring-2 focus:ring-brand-primary
                        focus:ring-offset-1 rounded-control"
                      >
                        Severity
                        <span aria-hidden="true" className="text-xs leading-none">
                          {severitySort === 'desc' ? '▼' : severitySort === 'asc' ? '▲' : '⇅'}
                        </span>
                      </button>
                    </th>
                    <th
                      scope="col"
                      className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[180px]"
                    >
                      Owner
                    </th>
                    {/* Quick-edit affordance column — no header */}
                    <th scope="col" className="w-10 px-2 py-3" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>{displayRisks.map((risk) => renderRow(risk))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type RiskActiveFacetChipsProps = Pick<
  RiskTablePanelProps,
  'isFiltered' | 'filter' | 'selectedCell' | 'onClearCell' | 'onClearAllFilters'
> & { onClearFilter: () => void; shownCount: number; totalCount: number };

/**
 * Active-facet status chip row — a removable token per active facet (segment
 * and/or matrix cell), each independently clearable, plus a Clear all reset.
 */
function RiskActiveFacetChips({
  isFiltered,
  filter,
  onClearFilter,
  selectedCell,
  onClearCell,
  onClearAllFilters,
  shownCount,
  totalCount,
}: RiskActiveFacetChipsProps) {
  return (
    <>
      {isFiltered && (
        <div
          className="flex flex-wrap items-center gap-2 mb-2 px-1 shrink-0"
          role="status"
          aria-live="polite"
        >
          <span className="text-xs text-neutral-text-secondary">Filtered to</span>
          {filter !== 'all' && (
            <span
              className="inline-flex items-center gap-1 text-xs font-medium
              bg-brand-primary/10 text-brand-primary border border-brand-primary/20 rounded-chip px-2 py-0.5"
            >
              {RISK_FILTERS.find((f) => f.value === filter)?.label}
              <button
                type="button"
                onClick={onClearFilter}
                aria-label="Clear severity/ownership filter"
                className="text-brand-primary hover:text-brand-primary-dark
                  focus:outline-none focus:ring-2 focus:ring-brand-primary
                  focus:ring-offset-1 rounded-control"
              >
                <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
          )}
          {selectedCell && (
            <span
              className="inline-flex items-center gap-1 text-xs font-medium tppm-mono
              bg-brand-primary/10 text-brand-primary border border-brand-primary/20 rounded-chip px-2 py-0.5"
            >
              P{selectedCell.probability} × I{selectedCell.impact}
              <button
                type="button"
                onClick={onClearCell}
                aria-label="Clear matrix cell filter"
                className="text-brand-primary hover:text-brand-primary-dark
                  focus:outline-none focus:ring-2 focus:ring-brand-primary
                  focus:ring-offset-1 rounded-control"
              >
                <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
          )}
          <span className="text-xs text-neutral-text-disabled">
            {shownCount} of {totalCount}
          </span>
          <button
            type="button"
            onClick={onClearAllFilters}
            className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary ml-1
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1 rounded-control"
          >
            Clear all
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Filtered-empty — risks exist but none match the active facets. The copy names
 * which facet(s) are responsible so the fix is obvious.
 */
function FilteredEmpty({
  selectedCell,
  filter,
  filterEmptyCopy,
  onClearAllFilters,
}: Pick<RiskTablePanelProps, 'selectedCell' | 'filter' | 'filterEmptyCopy' | 'onClearAllFilters'>) {
  let message = 'No risks match the selected cell.';
  if (selectedCell && filter !== 'all') message = 'No risks match the selected cell and filter.';
  else if (filter !== 'all') message = filterEmptyCopy[filter];
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-16"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm text-neutral-text-secondary">{message}</p>
      <button
        type="button"
        onClick={onClearAllFilters}
        className="text-sm text-brand-primary hover:underline
                  focus:outline-none focus:ring-2 focus:ring-brand-primary
                  focus:ring-offset-1 rounded-control"
      >
        Show all risks
      </button>
    </div>
  );
}

/** Nothing logged yet — the first-run state, with an import escape hatch for Member+. */
function RegisterEmptyState({
  canImport,
  onCreate,
  onOpenImport,
}: Pick<RiskTablePanelProps, 'canImport' | 'onCreate' | 'onOpenImport'>) {
  return (
    <EmptyState
      icon={RiskIcon}
      title="No risks yet"
      description="Log the things that could derail this project — then track likelihood, impact, and mitigation in one place."
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={onCreate}>+ Add your first risk</Button>
          {canImport && (
            <Button variant="secondary" onClick={onOpenImport}>
              Import CSV
            </Button>
          )}
        </div>
      }
    />
  );
}
