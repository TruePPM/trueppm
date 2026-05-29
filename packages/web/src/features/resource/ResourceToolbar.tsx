/**
 * Toolbar for the resource view — supports both Timeline and Utilization modes.
 *
 * Layout (left → right):
 *   [Timeline | Utilization]  [< Today >]  [start → end date range]  [⤢ Fit]  [My allocation]
 *
 * Secondary row: status filter pills (Timeline mode only).
 *
 * Design spec: UX spec v1.0, resource-allocation-timeline.html § ①
 */
import { formatWeekHeader } from './resourceUtils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  ToolbarOverflowMenu,
  type ToolbarOverflowItem,
} from '@/components/toolbar/ToolbarOverflowMenu';

export type ViewMode = 'timeline' | 'utilization';
type ViewModeLocal = ViewMode;

const ALL_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETE'] as const;
const STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  COMPLETE: 'Complete',
};

interface Props {
  viewMode: ViewModeLocal;
  onViewModeChange: (mode: ViewModeLocal) => void;
  windowStart: string;
  windowEnd: string;
  unassignedCount: number;
  /** Number of resources with at least one overallocated day in the current window. */
  overallocationCount: number;
  isFitToProject: boolean;
  myAllocationActive: boolean;
  showMyAllocation: boolean;
  statusFilters: string[];
  onStatusFiltersChange: (filters: string[]) => void;
  /** Free-text filter applied to resource names (timeline mode only). */
  resourceSearch: string;
  onResourceSearchChange: (value: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onFitToggle: () => void;
  onMyAllocationToggle: () => void;
}

export function ResourceToolbar({
  viewMode,
  onViewModeChange,
  windowStart,
  windowEnd,
  unassignedCount,
  overallocationCount,
  isFitToProject,
  myAllocationActive,
  showMyAllocation,
  statusFilters,
  onStatusFiltersChange,
  resourceSearch,
  onResourceSearchChange,
  onPrev,
  onNext,
  onToday,
  onFitToggle,
  onMyAllocationToggle,
}: Props) {
  const btnBase = `
    border border-neutral-border rounded h-7 px-2.5 text-xs font-medium
    text-neutral-text-secondary hover:text-neutral-text-primary
    focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
  `;
  const iconBtnBase = `
    border border-neutral-border rounded h-7 w-7
    flex items-center justify-center text-neutral-text-secondary
    hover:text-neutral-text-primary
    focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
  `;

  function toggleStatus(s: string) {
    if (statusFilters.includes(s)) {
      onStatusFiltersChange(statusFilters.filter((x) => x !== s));
    } else {
      onStatusFiltersChange([...statusFilters, s]);
    }
  }

  // Responsive toolbar tier (#568 rules 110–112). At `sm` the secondary row
  // (status filters + resource search) and the `My allocation` toggle move
  // into a shared ToolbarOverflowMenu so the primary row stays inside `h-10`.
  const breakpoint = useBreakpoint();

  return (
    <div className="flex-shrink-0 border-b border-neutral-border">
      {/* Primary row */}
      <div
        role="toolbar"
        aria-label="Resource toolbar"
        className="flex flex-nowrap items-center gap-2 px-4 h-10 bg-neutral-surface-raised"
      >
        {/* Segmented control: Timeline | Utilization */}
        <div
          role="group"
          aria-label="Resource view mode"
          className="flex border border-neutral-border rounded overflow-hidden flex-shrink-0"
        >
          {(['timeline', 'utilization'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={viewMode === mode}
              onClick={() => onViewModeChange(mode)}
              className={[
                'px-3 h-7 text-xs font-medium border-r border-neutral-border last:border-r-0',
                'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary focus-visible:outline-none',
                viewMode === mode
                  ? 'bg-brand-primary text-white'
                  : 'bg-neutral-surface text-neutral-text-secondary hover:text-neutral-text-primary',
              ].join(' ')}
            >
              {mode === 'timeline' ? 'Timeline' : 'Utilization'}
            </button>
          ))}
        </div>

        {/* Prev / Today / Next */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={onPrev}
            className={iconBtnBase}
            aria-label="Previous period"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M9 11L5 7l4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button type="button" onClick={onToday} className={btnBase}>
            Today
          </button>
          <button type="button" onClick={onNext} className={iconBtnBase} aria-label="Next period">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M5 3l4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {/* Date range — PRIMARY control */}
        <div
          className="flex items-center gap-1 border border-neutral-border rounded h-7 px-2.5 text-xs text-neutral-text-secondary bg-neutral-surface flex-shrink-0"
          aria-label={`Date window: ${formatWeekHeader(windowStart)} to ${formatWeekHeader(windowEnd)}`}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
            className="text-neutral-text-secondary"
          >
            <rect
              x="1"
              y="2"
              width="10"
              height="9"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path
              d="M1 5h10M4 1v2M8 1v2"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
          <span className="font-medium text-neutral-text-primary">
            {formatWeekHeader(windowStart)}
          </span>
          <span className="text-neutral-text-secondary">→</span>
          <span className="font-medium text-neutral-text-primary">
            {formatWeekHeader(windowEnd)}
          </span>
        </div>

        {/* Fit to project */}
        <button
          type="button"
          onClick={onFitToggle}
          className={[
            btnBase,
            isFitToProject ? 'border-brand-primary/40 text-brand-primary bg-brand-primary/5' : '',
          ].join(' ')}
        >
          {isFitToProject ? 'Reset to today' : '⤢ Fit to project'}
        </button>

        {/* My allocation (timeline mode only, when user has a resource record).
            Secondary control per rule 110 — visible at md+, collapses into the
            ToolbarOverflowMenu at sm. */}
        {showMyAllocation && viewMode === 'timeline' && breakpoint !== 'sm' && (
          <button
            type="button"
            onClick={onMyAllocationToggle}
            aria-pressed={myAllocationActive}
            className={[
              btnBase,
              'flex-shrink-0',
              myAllocationActive
                ? 'border-brand-primary/60 bg-brand-primary/10 text-brand-primary font-semibold'
                : '',
            ].join(' ')}
          >
            {myAllocationActive ? '✓ My allocation' : 'My allocation'}
          </button>
        )}

        <div className="flex-1" />

        {/* Resource toolbar overflow — at sm, secondary row collapses into a
            single ⋯ button on the primary row. */}
        {breakpoint === 'sm' && viewMode === 'timeline' && (
          <ToolbarOverflowMenu
            triggerAriaLabel="Resource secondary controls"
            items={[
              ...(showMyAllocation
                ? [
                    {
                      kind: 'checkbox' as const,
                      id: 'my-allocation',
                      label: 'My allocation',
                      checked: myAllocationActive,
                      onChange: () => onMyAllocationToggle(),
                    },
                  ]
                : []),
              ...ALL_STATUSES.map<ToolbarOverflowItem>((s) => ({
                kind: 'checkbox',
                id: `status-${s}`,
                label: STATUS_LABELS[s],
                checked: statusFilters.includes(s),
                onChange: () => toggleStatus(s),
              })),
            ]}
          />
        )}

        {/* Overallocation count (timeline mode) */}
        {overallocationCount > 0 && viewMode === 'timeline' && (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded border border-semantic-critical/40 text-semantic-critical bg-semantic-critical-bg"
            aria-live="polite"
            aria-label={`${overallocationCount} over-allocated resource${overallocationCount !== 1 ? 's' : ''}`}
          >
            {overallocationCount} over-allocated
          </span>
        )}

        {/* Unassigned count (utilization mode) */}
        {unassignedCount > 0 && viewMode === 'utilization' && (
          <span className="text-xs text-semantic-at-risk" aria-live="polite">
            {unassignedCount} task{unassignedCount !== 1 ? 's' : ''} without assignment
          </span>
        )}
      </div>

      {/* Secondary row: status filters + resource search (timeline mode only).
          Rendered only at md+ — at sm these controls live inside the overflow
          menu on the primary row (#568 rules 110–112). */}
      {viewMode === 'timeline' && breakpoint !== 'sm' && (
        <div className="flex items-center gap-3 px-4 py-1 bg-neutral-surface border-t border-neutral-border/50 text-xs text-neutral-text-secondary">
          <span className="text-xs uppercase tracking-wide text-neutral-text-secondary/70 flex-shrink-0">
            Status
          </span>
          {ALL_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={statusFilters.includes(s)}
                onChange={() => toggleStatus(s)}
                className="accent-brand-primary"
                aria-label={STATUS_LABELS[s]}
              />
              <span>{STATUS_LABELS[s]}</span>
            </label>
          ))}
          <div className="ml-4 flex items-center gap-1.5 border border-neutral-border rounded h-6 px-2 bg-neutral-surface min-w-[140px]">
            <svg
              width="11"
              height="11"
              viewBox="0 0 11 11"
              fill="none"
              aria-hidden="true"
              className="text-neutral-text-secondary flex-shrink-0"
            >
              <circle cx="4.5" cy="4.5" r="3.5" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M7.5 7.5l2 2"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
            <input
              type="search"
              value={resourceSearch}
              onChange={(e) => onResourceSearchChange(e.target.value)}
              placeholder="Filter resources…"
              aria-label="Filter resources by name"
              className="flex-1 min-w-0 bg-transparent outline-none text-xs text-neutral-text-primary placeholder:text-neutral-text-secondary"
            />
          </div>
        </div>
      )}
    </div>
  );
}
