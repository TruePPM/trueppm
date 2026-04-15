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
  isFitToProject: boolean;
  myAllocationActive: boolean;
  showMyAllocation: boolean;
  statusFilters: string[];
  onStatusFiltersChange: (filters: string[]) => void;
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
  isFitToProject,
  myAllocationActive,
  showMyAllocation,
  statusFilters,
  onStatusFiltersChange,
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

  return (
    <div className="flex-shrink-0 border-b border-neutral-border">
      {/* Primary row */}
      <div className="flex items-center gap-2 px-4 h-10 bg-neutral-surface-raised flex-wrap">

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
          <button type="button" onClick={onPrev} className={iconBtnBase} aria-label="Previous period">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" onClick={onToday} className={btnBase}>
            Today
          </button>
          <button type="button" onClick={onNext} className={iconBtnBase} aria-label="Next period">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Date range — PRIMARY control */}
        <div
          className="flex items-center gap-1 border border-neutral-border rounded h-7 px-2.5 text-xs text-neutral-text-secondary bg-neutral-surface flex-shrink-0"
          aria-label={`Date window: ${formatWeekHeader(windowStart)} to ${formatWeekHeader(windowEnd)}`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="text-neutral-text-secondary">
            <rect x="1" y="2" width="10" height="9" rx="1" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M1 5h10M4 1v2M8 1v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="font-medium text-neutral-text-primary">{formatWeekHeader(windowStart)}</span>
          <span className="text-neutral-text-secondary">→</span>
          <span className="font-medium text-neutral-text-primary">{formatWeekHeader(windowEnd)}</span>
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

        {/* My allocation (timeline mode only, when user has a resource record) */}
        {showMyAllocation && viewMode === 'timeline' && (
          <button
            type="button"
            onClick={onMyAllocationToggle}
            aria-pressed={myAllocationActive}
            className={[
              btnBase,
              myAllocationActive
                ? 'border-brand-primary/60 bg-brand-primary/10 text-brand-primary font-semibold'
                : '',
            ].join(' ')}
          >
            {myAllocationActive ? '✓ My allocation' : 'My allocation'}
          </button>
        )}

        <div className="flex-1" />

        {/* Unassigned count (utilization mode) */}
        {unassignedCount > 0 && viewMode === 'utilization' && (
          <span className="text-xs text-semantic-at-risk" aria-live="polite">
            {unassignedCount} task{unassignedCount !== 1 ? 's' : ''} without assignment
          </span>
        )}
      </div>

      {/* Secondary row: status filters (timeline mode only) */}
      {viewMode === 'timeline' && (
        <div className="flex items-center gap-3 px-4 py-1 bg-neutral-surface border-t border-neutral-border/50 text-xs text-neutral-text-secondary">
          <span className="text-[10px] uppercase tracking-wide text-neutral-text-secondary/70 flex-shrink-0">
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
        </div>
      )}
    </div>
  );
}
