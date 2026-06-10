import type { ReactNode } from 'react';
import type { SprintOutcome } from '@/hooks/useSprints';

interface Props {
  outcome: SprintOutcome;
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
export function SprintClosedOutcome({ outcome }: Props) {
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

      <DidntShipList outcome={outcome} />
    </div>
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
