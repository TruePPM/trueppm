import type { ApiSprint } from '@/types';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { formatDateRange, daysUntil } from './sprintMath';

/** Threshold (in days) at which the planned card flips from `Edit` → `Activate →`. */
const ACTIVATE_THRESHOLD_DAYS = 3;

interface Props {
  closed: ApiSprint[];
  active: ApiSprint | null;
  planned: ApiSprint[];
  /** The sprint currently shown in the workspace body — the strip is its
   *  selector (#567). The selected card gets a navy ring + aria-current. */
  selectedSprintId?: string | null;
  /** Select a sprint to review (click any card). */
  onSelect?: (sprintId: string) => void;
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
  selectedSprintId,
  onSelect,
  onPlanNext,
  onActivate,
  onEditPlanned,
  iterationWeeks,
  milestoneName,
}: Props) {
  const itl = useIterationLabel();
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
          {itl.singular} Cadence
        </h2>
      </div>

      <div className="flex items-stretch gap-3 overflow-x-auto pb-1">
        {closed.map((s) => (
          <SprintCard
            key={s.id}
            sprint={s}
            variant="closed"
            isSelected={s.id === selectedSprintId}
            onSelect={onSelect}
          />
        ))}
        {active && (
          <SprintCard
            sprint={active}
            variant="active"
            isSelected={active.id === selectedSprintId}
            onSelect={onSelect}
            data-testid="active-sprint-card"
          />
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
              isSelected={s.id === selectedSprintId}
              onSelect={onSelect}
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
            + Plan next {itl.lower}
          </button>
        )}
      </div>

      <p className="text-xs text-neutral-text-secondary flex items-center justify-between gap-3">
        <span>
          Project {itl.lower} cadence
          {iterationWeeks ? (
            <>
              {' · '}
              <span className="tppm-mono">{iterationWeeks}-week</span> {itl.lowerPlural}
            </>
          ) : null}
          {milestoneName ? <> toward <strong className="font-medium text-neutral-text-primary">{milestoneName}</strong></> : null}
        </span>
        <span className="text-neutral-text-secondary italic">
          one active {itl.lower} per project
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
  isSelected?: boolean;
  onSelect?: (sprintId: string) => void;
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
  isSelected,
  onSelect,
  onPlanNext,
  onActivate,
  onEditPlanned,
  ...rest
}: SprintCardProps) {
  const tone =
    variant === 'active'
      ? 'border-brand-primary bg-semantic-on-track-bg sticky left-0 z-10'
      : variant === 'closed'
        ? 'border-neutral-border bg-neutral-surface-sunken text-neutral-text-secondary'
        : 'border-neutral-border bg-neutral-surface';
  // Selected card gets a NAVY ring (rules 83/146): sage already carries
  // action + on-track meaning (the active card has a sage tint + sage progress
  // fill), so a sage selection ring would collide — selection is navy ink,
  // never sage. The active-but-unselected card keeps a faint sage tint ring as
  // its active cue; navy selection over it reads cleanly.
  const ring = isSelected
    ? 'ring-2 ring-navy-700 ring-offset-1 dark:ring-reversed'
    : variant === 'active'
      ? 'ring-2 ring-brand-primary/30'
      : '';

  const committed = sprint.committed_points ?? 0;
  const completed = sprint.completed_points ?? 0;

  return (
    <article
      {...rest}
      className={`relative shrink-0 w-56 rounded-md border p-3 flex flex-col gap-2 ${tone} ${ring}`}
      aria-label={`${sprint.short_id_display} ${sprint.name}, ${variant}`}
      aria-current={isSelected || undefined}
    >
      {/* Full-card overlay button = the selector. Sits above the (non-interactive)
          text but below the planned-card action button (z-20), so clicking the
          card selects it while the Activate/Edit button keeps its own handler. */}
      {onSelect && (
        <button
          type="button"
          onClick={() => onSelect(sprint.id)}
          aria-label={`Review ${sprint.short_id_display} ${sprint.name}`}
          className="absolute inset-0 z-10 rounded-md
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
      )}
      {/* Name leads (the sprint's identity); the zero-padded short_id_display is
          demoted off the card face — it stays in the article aria-label so screen
          readers and the selector keep it (#1107 ux-review: a DB key shouldn't
          out-weigh the name). */}
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-neutral-text-primary truncate" title={sprint.name}>
          {sprint.name}
        </p>
        <span className="shrink-0 text-xs uppercase tracking-wide text-neutral-text-secondary">
          {variant}
        </span>
      </div>

      <p className="tppm-mono text-xs text-neutral-text-secondary">
        {formatDateRange(sprint.start_date, sprint.finish_date)}
      </p>

      {variant !== 'planned' && committed > 0 && (
        <>
          <CommitmentBar committed={committed} completed={completed} />
          <p className="tppm-mono text-xs text-neutral-text-secondary flex items-center gap-1.5">
            <span>
              {completed}/{committed} pts
            </span>
            {completed > committed && (
              // Over-commitment cue is never colour-alone (WCAG 1.4.1 / rules 145, 159):
              // the ⚠ glyph + "+N over" text carry the signal; text uses the AA-dark
              // at-risk token, the brand amber stays a fill (the bar overflow segment).
              <span className="font-medium text-semantic-at-risk inline-flex items-center gap-0.5">
                <span aria-hidden="true">⚠</span>+{completed - committed} over
              </span>
            )}
          </p>
        </>
      )}

      {variant === 'planned' && (
        <div className="relative z-20 flex">
          <PlannedCardAction
            sprint={sprint}
            isLast={isLast ?? false}
            isReadyToActivate={isReadyToActivate ?? false}
            onActivate={onActivate}
            onEditPlanned={onEditPlanned}
            onPlanNext={onPlanNext}
          />
        </div>
      )}
    </article>
  );
}

/**
 * Commitment progress bar that makes over-commitment visible (#1107).
 *
 * The bar's full width represents `max(committed, completed)`, so when a sprint
 * completes MORE than it committed the extra is shown as a distinct **amber
 * overflow segment past a navy capacity tick** — never a clamped full green bar
 * that reads as "done" (the VoC blocker from Jordan + Alex). Under/at commitment
 * there is no overflow and no tick (the bar end IS the capacity line).
 *
 * Colour is never the sole signal: the capacity tick is a structural cue and the
 * card's `+N over` label (rule 145/159) carries the text equivalent. ARIA keeps
 * `valuenow ≤ valuemax` by scaling `valuemax` to the bar denominator and putting
 * the commitment + overage into `aria-valuetext`.
 */
function CommitmentBar({ committed, completed }: { committed: number; completed: number }) {
  const denom = Math.max(committed, completed, 1);
  const inCommit = Math.min(completed, committed);
  const over = Math.max(0, completed - committed);
  const greenPct = (inCommit / denom) * 100;
  const overPct = (over / denom) * 100;
  const capPct = (committed / denom) * 100;
  const isOver = over > 0;

  return (
    <div
      className="relative h-1.5 w-full rounded-full bg-neutral-surface-sunken overflow-hidden"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={denom}
      aria-valuenow={completed}
      aria-label={
        isOver
          ? `${completed} of ${committed} points committed, ${over} over commitment`
          : `${completed} of ${committed} points complete`
      }
    >
      <div
        className="absolute inset-y-0 left-0 bg-semantic-on-track"
        style={{ width: `${greenPct}%` }}
      />
      {isOver && (
        <div
          className="absolute inset-y-0 bg-semantic-at-risk"
          style={{ left: `${capPct}%`, width: `${overPct}%` }}
        />
      )}
      {isOver && (
        // Navy capacity tick at the commitment line — the non-colour structural
        // cue that the team crossed its committed scope (rules 146/147, 1.4.1).
        <div
          aria-hidden="true"
          className="absolute inset-y-0 w-0.5 bg-neutral-text-primary"
          style={{ left: `${capPct}%` }}
        />
      )}
    </div>
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
