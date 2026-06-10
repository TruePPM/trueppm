import type { Ref } from 'react';
import type { ApiSprint, SprintState } from '@/types';

interface Props {
  /** The currently-active sprint (or null when none is active). */
  sprint: ApiSprint | null;
  /** 1-based sprint number derived from chronological order in the project. */
  sprintNumber: number;
  /** True when at least one sprint is already in PLANNED state. */
  hasPlannedSprint: boolean;
  onPlanNext: () => void;
  onCloseSprint: () => void;
  onFilter: () => void;
  /** Optional ref forwarded to the Filter button — anchor for the popover (#299). */
  filterButtonRef?: Ref<HTMLButtonElement>;
}

const STATE_PILL_STYLE: Record<SprintState, string> = {
  ACTIVE: 'border-semantic-on-track/40 text-semantic-on-track',
  PLANNED: 'border-neutral-border text-neutral-text-secondary',
  COMPLETED: 'border-neutral-border text-neutral-text-disabled',
  CANCELLED: 'border-neutral-border text-neutral-text-disabled',
};

const STATE_LABEL: Record<SprintState, string> = {
  ACTIVE: 'Active',
  PLANNED: 'Planned',
  COMPLETED: 'Closed',
  CANCELLED: 'Cancelled',
};

/**
 * Sprint workspace header — H1, status pill, and the three action buttons.
 *
 * Action button gating (issue #227 acceptance criteria):
 *  - Close sprint: enabled only when current sprint state is ACTIVE
 *  - Plan next sprint: disabled when a PLANNED sprint already exists (one
 *    active sprint per project ⇒ at most one queued planned at a time)
 *  - Filter: always available; opens the sprint filter popover
 */
export function SprintHeader({
  sprint,
  sprintNumber,
  hasPlannedSprint,
  onPlanNext,
  onCloseSprint,
  onFilter,
  filterButtonRef,
}: Props) {
  const isActive = sprint?.state === 'ACTIVE';

  return (
    <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 shrink-0">
      <div className="min-w-0 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-text-primary leading-tight truncate">
          {sprint ? `Sprint ${sprintNumber} — ${sprint.name}` : 'No sprint yet'}
          {sprint && (
            <span
              className={`ml-3 inline-flex items-center align-middle bg-transparent border ${STATE_PILL_STYLE[sprint.state]} rounded px-2 py-0.5 text-xs font-medium`}
              aria-label={`Sprint state: ${STATE_LABEL[sprint.state]}`}
            >
              {STATE_LABEL[sprint.state]}
            </span>
          )}
        </h1>
      </div>

      <div className="flex items-center gap-2 shrink-0 pt-1">
        <button
          ref={filterButtonRef}
          type="button"
          onClick={onFilter}
          aria-haspopup="dialog"
          className="h-8 px-3 rounded text-xs font-medium border border-neutral-border
            text-neutral-text-secondary hover:text-neutral-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Filter
        </button>
        <button
          type="button"
          onClick={onPlanNext}
          disabled={hasPlannedSprint}
          aria-label={
            hasPlannedSprint
              ? 'Plan next sprint (a planned sprint already exists)'
              : 'Plan next sprint'
          }
          className="h-8 px-3 rounded text-xs font-medium border border-neutral-border
            text-neutral-text-secondary hover:text-neutral-text-primary
            disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed disabled:hover:text-neutral-text-secondary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Plan next sprint
        </button>
        <button
          type="button"
          onClick={onCloseSprint}
          disabled={!isActive}
          aria-label={isActive ? 'Close active sprint' : 'Close sprint (no active sprint)'}
          // Disabled state drops to neutral disabled styling so it reads as
          // "unavailable" rather than "faded red". A 50%-opacity red button
          // still parses as a clickable destructive action — too subtle.
          className="h-8 px-3 rounded text-xs font-medium border bg-transparent
            border-semantic-critical/40 text-semantic-critical hover:bg-semantic-critical-bg
            disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken disabled:hover:bg-neutral-surface-sunken
            disabled:border-neutral-border disabled:text-neutral-text-disabled
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
        >
          Close sprint
        </button>
      </div>
    </header>
  );
}
