import type { ReactNode } from 'react';
import { useToggleDemo, type ReviewShippedStory, type SprintOutcome } from '@/hooks/useSprints';

interface Props {
  outcome: SprintOutcome;
  /** True when the requester is Member+ and may curate the demo list (#924). */
  canCurateDemo?: boolean;
}

const GOAL_LABEL: Record<string, string> = {
  MET: 'Met',
  PARTIAL: 'Partial',
  MISSED: 'Missed',
};

/**
 * CLOSED-state review surface (#567, ADR-0094) — the "what was done" outcome,
 * bound entirely to `GET /sprints/{id}/outcome/` (#985). Renders the 5-card
 * outcome row (goal verdict, committed/completed points, rolled-over, velocity Δ)
 * and the read-only "what didn't ship" list. The frozen burndown and retro panel
 * are rendered by the parent (existing components). Every value is server-owned;
 * nothing is derived here.
 */
export function SprintClosedOutcome({ outcome, canCurateDemo = false }: Props) {
  const c = outcome.commitment;
  const v = outcome.velocity;
  const rolled = rolledOverPoints(c.committed_points, c.completed_points);

  return (
    <div className="flex flex-col gap-4" data-testid="sprint-closed-outcome">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <OutcomeCard label="Goal">
          <GoalVerdict status={outcome.goal_outcome} />
        </OutcomeCard>
        <OutcomeCard label="Committed">
          <Pts value={c.committed_points} />
        </OutcomeCard>
        <OutcomeCard label="Completed">
          <Pts value={c.completed_points} />
          {c.completion_ratio_points != null && (
            <span className="text-xs text-neutral-text-secondary">
              {' '}
              ({Math.round(c.completion_ratio_points * 100)}%)
            </span>
          )}
        </OutcomeCard>
        <OutcomeCard label="Rolled over">
          <Pts value={rolled} />
        </OutcomeCard>
        <OutcomeCard label="Velocity Δ">
          {v && v.velocity_delta_points != null ? (
            <DeltaValue delta={v.velocity_delta_points} />
          ) : (
            <span className="text-sm text-neutral-text-secondary">—</span>
          )}
        </OutcomeCard>
      </div>

      <SprintReviewSection outcome={outcome} canCurate={canCurateDemo} />

      <DidntShipList outcome={outcome} />
    </div>
  );
}

/**
 * Sprint Review (#924, ADR-0118): the accepted-vs-not acceptance breakdown and the
 * shipped-stories list with a per-story demo toggle. Distinct from the retro — this
 * is Jordan's acceptance ceremony. Counts are server-owned; the demo list is the
 * subset the team flagged for the stakeholder walkthrough.
 */
function SprintReviewSection({
  outcome,
  canCurate,
}: {
  outcome: SprintOutcome;
  canCurate: boolean;
}) {
  const r = outcome.review;
  const toggle = useToggleDemo(outcome.sprint_id);

  return (
    <div className="rounded-md border border-neutral-border bg-neutral-surface" data-testid="sprint-review">
      <h3 className="px-3 py-2 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary border-b border-neutral-border">
        Sprint review
      </h3>

      {/* Acceptance breakdown — counts always; points only when readable (ADR-0104). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm border-b border-neutral-border">
        <span className="text-semantic-on-track font-medium" data-testid="accepted-count">
          <span aria-hidden="true">✓ </span>
          {r.accepted_count} accepted
          {r.accepted_points != null && (
            <span className="text-neutral-text-secondary font-normal"> ({r.accepted_points} pts)</span>
          )}
        </span>
        <span className="text-semantic-at-risk font-medium">
          {r.not_accepted_count} not accepted
          {r.not_accepted_points != null && (
            <span className="text-neutral-text-secondary font-normal">
              {' '}
              ({r.not_accepted_points} pts)
            </span>
          )}
        </span>
        {r.no_criteria_count > 0 && (
          <span
            className="text-neutral-text-secondary"
            title="Committed stories with no acceptance criteria — a coverage gap to close in refinement."
          >
            {r.no_criteria_count} no criteria
          </span>
        )}
      </div>

      {/* Shipped stories + demo curation. */}
      {r.shipped.length === 0 ? (
        <p role="status" className="px-3 py-3 text-xs italic text-neutral-text-secondary">
          No stories shipped this sprint.
        </p>
      ) : (
        <>
          <div className="px-3 pt-2 text-xs text-neutral-text-secondary">
            Shipped ({r.shipped.length})
            {r.demo_list.length > 0 && (
              <> · <span aria-hidden="true">★ </span>{r.demo_list.length} for demo</>
            )}
          </div>
          <ul className="divide-y divide-neutral-border">
            {r.shipped.map((s) => (
              <ShippedRow
                key={s.outcome_id ?? s.task_short_id}
                story={s}
                canCurate={canCurate}
                pending={toggle.isPending}
                onToggle={(demoReady) =>
                  s.outcome_id && toggle.mutate({ outcomeId: s.outcome_id, demoReady })
                }
              />
            ))}
          </ul>
        </>
      )}
      {toggle.isError && (
        <p role="alert" className="px-3 py-2 text-xs text-semantic-critical">
          Couldn&apos;t update the demo list. Please try again.
        </p>
      )}
    </div>
  );
}

function ShippedRow({
  story,
  canCurate,
  pending,
  onToggle,
}: {
  story: ReviewShippedStory;
  canCurate: boolean;
  pending: boolean;
  onToggle: (demoReady: boolean) => void;
}) {
  const { acceptance: a } = story;
  const fullyAccepted = a.total > 0 && a.met === a.total;
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <span className="tppm-mono text-xs text-neutral-text-secondary w-16 shrink-0">
        {story.task_short_id}
      </span>
      <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{story.task_title}</span>
      {/* Acceptance badge — text label, never color alone (WCAG 1.4.1). */}
      {a.total > 0 ? (
        <span
          className={`text-xs shrink-0 ${fullyAccepted ? 'text-semantic-on-track' : 'text-semantic-at-risk'}`}
          aria-label={`${a.met} of ${a.total} acceptance criteria met`}
        >
          <span aria-hidden="true">{fullyAccepted ? '✓ ' : ''}</span>
          {a.met}/{a.total} criteria
        </span>
      ) : (
        <span className="text-xs text-neutral-text-disabled shrink-0">no criteria</span>
      )}
      {story.story_points != null && (
        <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">
          {story.story_points} pts
        </span>
      )}
      {/* Demo toggle (Member+) — or a static marker for read-only viewers. */}
      {canCurate && story.outcome_id ? (
        <button
          type="button"
          role="switch"
          aria-checked={story.demo_ready}
          aria-label={`${story.demo_ready ? 'Remove from' : 'Add to'} demo list: ${story.task_title}`}
          disabled={pending}
          onClick={() => onToggle(!story.demo_ready)}
          className={`shrink-0 h-7 px-2 rounded text-xs font-medium border whitespace-nowrap
            disabled:opacity-50 disabled:cursor-not-allowed
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
            ${
              story.demo_ready
                ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                : 'border-neutral-border text-neutral-text-secondary hover:border-brand-primary hover:text-brand-primary'
            }`}
        >
          <span aria-hidden="true">{story.demo_ready ? '★' : '☆'} </span>Demo
        </button>
      ) : story.demo_ready ? (
        <span className="shrink-0 text-xs text-brand-primary" aria-label="In the demo list">
          <span aria-hidden="true">★ </span>Demo
        </span>
      ) : null}
    </li>
  );
}

function OutcomeCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-neutral-border bg-neutral-surface-raised p-3 flex flex-col gap-1">
      <span className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
        {label}
      </span>
      <span className="flex items-baseline">{children}</span>
    </div>
  );
}

function Pts({ value }: { value: number | null }) {
  if (value == null) return <span className="text-sm text-neutral-text-secondary">—</span>;
  return (
    <span className="tppm-mono text-lg font-semibold text-neutral-text-primary">{value}</span>
  );
}

function GoalVerdict({ status }: { status: SprintOutcome['goal_outcome'] }) {
  if (status == null) {
    return <span className="text-sm text-neutral-text-secondary">—</span>;
  }
  const tone =
    status === 'MET'
      ? 'text-semantic-on-track'
      : status === 'PARTIAL'
        ? 'text-semantic-at-risk'
        : 'text-semantic-critical';
  const glyph = status === 'MET' ? '✓' : status === 'PARTIAL' ? '◐' : '✗';
  return (
    <span className={`text-sm font-semibold ${tone}`} aria-label={`Goal ${GOAL_LABEL[status]}`}>
      <span aria-hidden="true">{glyph} </span>
      {GOAL_LABEL[status]}
    </span>
  );
}

function DeltaValue({ delta }: { delta: number }) {
  // A drop in velocity is a watch-signal (amber), not an error — reserve critical
  // red for genuine failure states (rule 145).
  const tone =
    delta > 0
      ? 'text-semantic-on-track'
      : delta < 0
        ? 'text-semantic-at-risk'
        : 'text-neutral-text-primary';
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '·';
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged';
  return (
    <span
      className={`tppm-mono text-lg font-semibold ${tone}`}
      aria-label={
        delta === 0
          ? 'Velocity unchanged vs prior sprint'
          : `Velocity ${direction} ${Math.abs(delta)} points vs prior sprint`
      }
    >
      <span aria-hidden="true">{arrow} </span>
      {delta > 0 ? '+' : ''}
      {delta}
    </span>
  );
}

function DidntShipList({ outcome }: { outcome: SprintOutcome }) {
  const { didnt_ship: items, didnt_ship_summary: sum, outcome_recorded } = outcome;

  if (!outcome_recorded) {
    return (
      <p
        role="status"
        className="rounded-md border border-dashed border-neutral-border bg-neutral-surface p-4 text-xs text-neutral-text-secondary"
      >
        Per-task membership was not recorded for this sprint (it closed before
        membership capture shipped).
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p
        role="status"
        className="rounded-md border border-neutral-border bg-neutral-surface p-4 text-xs text-neutral-text-secondary"
      >
        <span aria-hidden="true">🎉 </span>Everything committed shipped.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-neutral-border bg-neutral-surface" data-testid="didnt-ship">
      <h3 className="px-3 py-2 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary border-b border-neutral-border">
        What didn&apos;t ship ({items.length})
        {sum.carried_count > 0 && <> · {sum.carried_count} carried</>}
        {sum.dropped_count > 0 && <> · {sum.dropped_count} dropped</>}
      </h3>
      <ul className="divide-y divide-neutral-border">
        {items.map((it) => (
          <li
            key={`${it.task_short_id}-${it.task_id ?? it.task_title}`}
            className="flex items-center gap-3 px-3 py-2 text-sm"
          >
            <span className="tppm-mono text-xs text-neutral-text-secondary w-16 shrink-0">
              {it.task_short_id}
            </span>
            <span className="flex-1 min-w-0 truncate text-neutral-text-primary">
              {it.task_title}
            </span>
            {it.story_points != null && (
              <span className="tppm-mono text-xs text-neutral-text-secondary">
                {it.story_points} pts
              </span>
            )}
            <DispositionChip item={it} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DispositionChip({ item }: { item: SprintOutcome['didnt_ship'][number] }) {
  if (item.disposition === 'carried') {
    return (
      <span className="text-xs text-neutral-text-secondary shrink-0">
        → {item.next_sprint_name ?? 'next sprint'}
      </span>
    );
  }
  if (item.disposition === 'dropped') {
    return <span className="text-xs text-neutral-text-secondary shrink-0">dropped</span>;
  }
  return null;
}

/** committed − completed, floored at 0 (proxy for rolled-over per ADR-0111 §C). */
function rolledOverPoints(committed: number | null, completed: number | null): number | null {
  if (committed == null) return null;
  return Math.max(0, committed - (completed ?? 0));
}
