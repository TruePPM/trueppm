/**
 * Toolbar for the resource utilization view.
 *
 * Contains:
 *  - Previous / Today / Next navigation buttons (rule 93)
 *  - Current window label
 *  - "Fit to project" / "Reset to today" toggle button (rule 93)
 *  - Unassigned task count badge (rule 98)
 */
import { formatWeekHeader } from './resourceUtils';

interface Props {
  windowStart: string;
  windowEnd: string;
  unassignedCount: number;
  isFitToProject: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onFitToggle: () => void;
}

export function ResourceToolbar({
  windowStart,
  windowEnd,
  unassignedCount,
  isFitToProject,
  onPrev,
  onNext,
  onToday,
  onFitToggle,
}: Props) {
  const chevronClass = `
    border border-neutral-border rounded h-7 w-7
    flex items-center justify-center text-neutral-text-secondary
    hover:text-neutral-text-primary
    focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
  `;
  const btnClass = `
    border border-neutral-border rounded h-7 px-3 text-xs font-medium
    text-neutral-text-secondary hover:text-neutral-text-primary
    focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
  `;

  return (
    <div className="flex items-center gap-2 px-4 h-10 border-b border-neutral-border bg-neutral-surface-raised flex-shrink-0">
      {/* Navigation */}
      <button type="button" onClick={onPrev} className={chevronClass} aria-label="Previous period">
        {/* Left chevron */}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <button type="button" onClick={onToday} className={btnClass}>
        Today
      </button>

      <button type="button" onClick={onNext} className={chevronClass} aria-label="Next period">
        {/* Right chevron */}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Window label */}
      <span className="text-xs text-neutral-text-secondary">
        {formatWeekHeader(windowStart)} – {formatWeekHeader(windowEnd)}
      </span>

      <div className="flex-1" />

      {/* Unassigned task count (rule 98) */}
      {unassignedCount > 0 && (
        <span className="text-xs text-semantic-at-risk" aria-live="polite">
          {unassignedCount} task{unassignedCount !== 1 ? 's' : ''} without resource assignment
        </span>
      )}

      {/* Fit to project / Reset to today toggle (rule 93) */}
      <button type="button" onClick={onFitToggle} className={btnClass}>
        {isFitToProject ? 'Reset to today' : 'Fit to project'}
      </button>
    </div>
  );
}
