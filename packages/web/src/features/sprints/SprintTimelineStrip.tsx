import type { ApiSprint } from '@/types';
import { formatDateRange, daysUntil } from './sprintMath';

/** Threshold (in days) at which the planned card flips from `Edit` → `Activate →`. */
const ACTIVATE_THRESHOLD_DAYS = 3;

interface Props {
  closed: ApiSprint[];
  active: ApiSprint | null;
  planned: ApiSprint[];
  onPlanNext: () => void;
  /** Activate the given planned sprint (issue #299). When omitted, the
   *  Activate→ button on the last-planned card is hidden. */
  onActivate?: (sprintId: string) => void;
  /** Edit the given planned sprint (issue #299). When omitted, the Edit
   *  button on planned cards is hidden. */
  onEditPlanned?: (sprintId: string) => void;
  /** Iteration length in weeks, derived from the median sprint width. */
  iterationWeeks?: number;
  /** Milestone the cadence is targeting; rendered into the caption. */
  milestoneName?: string | null;
}

/**
 * Horizontal timeline of every sprint in the project, grouped by state.
 *
 * Layout: closed sprints (scrollable, greyed) → active sprint (sticky, ringed) →
 * planned sprints (scrollable, neutral) → "+ Plan next sprint" affordance.
 *
 * Caption row below summarises the cadence and the linked milestone, with a
 * right-aligned reminder of the single-active-sprint constraint.
 */
export function SprintTimelineStrip({
  closed,
  active,
  planned,
  onPlanNext,
  onActivate,
  onEditPlanned,
  iterationWeeks,
  milestoneName,
}: Props) {
  const showPlanSlot = planned.length === 0;

  return (
    <section
      aria-labelledby="sprint-timeline-heading"
      className="border-t border-neutral-border bg-neutral-surface-raised px-6 py-4 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <h2
          id="sprint-timeline-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Sprint Cadence
        </h2>
      </div>

      <div className="flex items-stretch gap-3 overflow-x-auto pb-1">
        {closed.map((s) => (
          <SprintCard key={s.id} sprint={s} variant="closed" />
        ))}
        {active && (
          <SprintCard sprint={active} variant="active" data-testid="active-sprint-card" />
        )}
        {planned.map((s, idx) => {
          const isLast = idx === planned.length - 1;
          // Only the last-planned card carries an action — the user advances
          // sprints in cadence, never out of order. Pre-active window:
          // start_date is within ACTIVATE_THRESHOLD_DAYS → Activate →.
          // Otherwise → Edit (PATCH via PlanSprintModal in edit mode).
          const daysToStart = daysUntil(s.start_date);
          const isReadyToActivate = isLast && daysToStart <= ACTIVATE_THRESHOLD_DAYS;
          return (
            <SprintCard
              key={s.id}
              sprint={s}
              variant="planned"
              isLast={isLast}
              isReadyToActivate={isReadyToActivate}
              onActivate={onActivate}
              onEditPlanned={onEditPlanned}
              onPlanNext={onPlanNext}
            />
          );
        })}
        {showPlanSlot && (
          <button
            type="button"
            onClick={onPlanNext}
            className="shrink-0 w-48 rounded-md border-2 border-dashed border-neutral-border
              bg-neutral-surface text-sm font-medium text-neutral-text-secondary
              hover:border-brand-primary/40 hover:text-brand-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              flex items-center justify-center min-h-[88px] px-3"
          >
            + Plan next sprint
          </button>
        )}
      </div>

      <p className="text-xs text-neutral-text-secondary flex items-center justify-between gap-3">
        <span>
          Project sprint cadence
          {iterationWeeks ? (
            <>
              {' · '}
              <span className="tppm-mono">{iterationWeeks}-week</span> iterations
            </>
          ) : null}
          {milestoneName ? <> toward <strong className="font-medium text-neutral-text-primary">{milestoneName}</strong></> : null}
        </span>
        <span className="text-neutral-text-disabled italic">
          one active sprint per project
        </span>
      </p>
    </section>
  );
}

interface SprintCardProps {
  sprint: ApiSprint;
  variant: 'closed' | 'active' | 'planned';
  isLast?: boolean;
  isReadyToActivate?: boolean;
  onPlanNext?: () => void;
  onActivate?: (sprintId: string) => void;
  onEditPlanned?: (sprintId: string) => void;
  'data-testid'?: string;
}

function SprintCard({
  sprint,
  variant,
  isLast,
  isReadyToActivate,
  onPlanNext,
  onActivate,
  onEditPlanned,
  ...rest
}: SprintCardProps) {
  const tone =
    variant === 'active'
      ? 'border-brand-primary ring-2 ring-brand-primary/30 bg-semantic-on-track-bg sticky left-0 z-10'
      : variant === 'closed'
        ? 'border-neutral-border bg-neutral-surface-sunken text-neutral-text-secondary'
        : 'border-neutral-border bg-neutral-surface';

  const committed = sprint.committed_points ?? 0;
  const completed = sprint.completed_points ?? 0;
  const ratio = committed > 0 ? Math.min(completed / committed, 1) : 0;

  return (
    <article
      {...rest}
      className={`shrink-0 w-56 rounded-md border p-3 flex flex-col gap-2 ${tone}`}
      aria-label={`${sprint.short_id_display} ${sprint.name}, ${variant}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="tppm-mono text-xs font-medium">{sprint.short_id_display}</span>
        <span className="text-xs uppercase tracking-wide text-neutral-text-disabled">
          {variant}
        </span>
      </div>

      <p className="text-sm font-medium text-neutral-text-primary truncate" title={sprint.name}>
        {sprint.name}
      </p>

      <p className="tppm-mono text-xs text-neutral-text-secondary">
        {formatDateRange(sprint.start_date, sprint.finish_date)}
      </p>

      {variant !== 'planned' && committed > 0 && (
        <div
          className="h-1.5 w-full rounded-full bg-neutral-surface-sunken overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={committed}
          aria-valuenow={completed}
          aria-label={`${completed} of ${committed} points complete`}
        >
          <div
            className="h-full bg-semantic-on-track"
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      )}

      {variant !== 'planned' && committed > 0 && (
        <p className="tppm-mono text-xs text-neutral-text-secondary">
          {completed}/{committed} pts
        </p>
      )}

      {variant === 'planned' && (
        <PlannedCardAction
          sprint={sprint}
          isLast={isLast ?? false}
          isReadyToActivate={isReadyToActivate ?? false}
          onActivate={onActivate}
          onEditPlanned={onEditPlanned}
          onPlanNext={onPlanNext}
        />
      )}
    </article>
  );
}

/**
 * Action button on a planned-sprint card. Three rendering modes:
 *  - last-planned + ready (≤ 3d before start): "Activate →" (filled, brand)
 *  - last-planned otherwise: "Edit" (ghost, neutral)
 *  - non-last planned: nothing — user advances the cadence in order, not
 *    out of order (no premature activation jumps allowed).
 *
 * Falls back to `onPlanNext` (legacy "Plan →" affordance) when neither
 * `onActivate` nor `onEditPlanned` is wired — preserves the old behavior
 * for any caller that hasn't migrated yet.
 */
function PlannedCardAction({
  sprint,
  isLast,
  isReadyToActivate,
  onActivate,
  onEditPlanned,
  onPlanNext,
}: {
  sprint: ApiSprint;
  isLast: boolean;
  isReadyToActivate: boolean;
  onActivate?: (sprintId: string) => void;
  onEditPlanned?: (sprintId: string) => void;
  onPlanNext?: () => void;
}) {
  if (!isLast) return null;

  if (isReadyToActivate && onActivate) {
    return (
      <button
        type="button"
        onClick={() => onActivate(sprint.id)}
        className="self-start h-7 px-2 rounded text-xs font-medium
          bg-brand-primary text-white hover:bg-brand-primary-dark
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Activate →
      </button>
    );
  }

  if (onEditPlanned) {
    return (
      <button
        type="button"
        onClick={() => onEditPlanned(sprint.id)}
        className="self-start text-xs font-medium text-neutral-text-secondary
          hover:text-brand-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
      >
        Edit
      </button>
    );
  }

  // Legacy fallback while callers migrate to the new handlers.
  if (onPlanNext) {
    return (
      <button
        type="button"
        onClick={onPlanNext}
        className="self-start text-xs font-medium text-brand-primary hover:text-brand-primary-dark
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
      >
        Plan →
      </button>
    );
  }
  return null;
}
