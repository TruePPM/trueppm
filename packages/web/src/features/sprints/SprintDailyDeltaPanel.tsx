import { useSprintDailyDelta, type SprintDailyDelta } from '@/hooks/useSprints';

interface Props {
  /** The ACTIVE sprint id — the daily standup is for the running sprint only. */
  sprintId: string;
}

/** Human labels for the raw TaskStatus values in a status transition. */
const STATUS_LABEL: Record<string, string> = {
  BACKLOG: 'Backlog',
  NOT_STARTED: 'To do',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Review',
  ON_HOLD: 'On hold',
  COMPLETE: 'Done',
};

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

/**
 * Daily standup surface (#925, ADR-0121) — the team's "what changed since
 * yesterday" on the active sprint. Pull-only (no notifications); bound entirely to
 * `GET /sprints/{id}/daily-delta/`. Status-level only — never hours/keystroke —
 * and team-private by membership (a PMO non-member can't reach the endpoint). Every
 * value is server-computed; nothing is derived here.
 */
export function SprintDailyDeltaPanel({ sprintId }: Props) {
  const query = useSprintDailyDelta(sprintId);

  if (query.isLoading) {
    return (
      <div className="h-24 rounded-md border border-neutral-border bg-neutral-surface-raised animate-pulse" />
    );
  }
  if (!query.data) return null;

  const d = query.data;
  const empty =
    d.task_changes.length === 0 &&
    d.scope_added.length === 0 &&
    d.new_blockers.length === 0 &&
    d.burndown_delta == null;

  return (
    <section
      aria-labelledby="daily-delta-heading"
      data-testid="sprint-daily-delta"
      className="rounded-md border border-neutral-border bg-neutral-surface flex flex-col"
    >
      <header className="flex items-baseline justify-between gap-3 px-3 py-2 border-b border-neutral-border">
        <h3
          id="daily-delta-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Since yesterday
        </h3>
        <span className="text-[10px] tppm-mono text-neutral-text-disabled">
          {relativeSince(d.since)}
        </span>
      </header>

      {empty ? (
        <p role="status" className="px-3 py-4 text-xs italic text-neutral-text-secondary">
          Nothing changed since yesterday.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-neutral-border">
          {d.burndown_delta && <BurndownRow delta={d.burndown_delta} />}
          {d.per_actor.length > 0 && <PerActorRow actors={d.per_actor} />}
          {d.new_blockers.length > 0 && <BlockersRow blockers={d.new_blockers} />}
          {d.task_changes.length > 0 && <MovedRow changes={d.task_changes} />}
          {d.scope_added.length > 0 && <ScopeRow items={d.scope_added} />}
        </div>
      )}
    </section>
  );
}

function BurndownRow({ delta }: { delta: NonNullable<SprintDailyDelta['burndown_delta']> }) {
  const down = delta.remaining_delta < 0; // remaining went DOWN = progress (good)
  const tone = down
    ? 'text-semantic-on-track'
    : delta.remaining_delta > 0
      ? 'text-semantic-at-risk'
      : 'text-neutral-text-secondary';
  const arrow = down ? '▼' : delta.remaining_delta > 0 ? '▲' : '·';
  return (
    <div className="px-3 py-2 text-sm flex items-center gap-2">
      <span className="text-xs text-neutral-text-secondary w-24 shrink-0">Burndown</span>
      <span className={`tppm-mono ${tone}`} aria-label={`Remaining work changed by ${delta.remaining_delta} points`}>
        <span aria-hidden="true">{arrow} </span>
        {delta.remaining_delta > 0 ? '+' : ''}
        {delta.remaining_delta} pts remaining
      </span>
      <span className="text-xs text-neutral-text-disabled">
        ({delta.prior_remaining} → {delta.current_remaining}
        {delta.completed_delta > 0 && <>, +{delta.completed_delta} done</>})
      </span>
    </div>
  );
}

function PerActorRow({ actors }: { actors: SprintDailyDelta['per_actor'] }) {
  return (
    <div className="px-3 py-2 flex flex-col gap-1">
      <span className="text-xs text-neutral-text-secondary">Who touched what</span>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {actors.map((a) => {
          const parts = [
            a.moved ? `${a.moved} moved` : null,
            a.completed ? `${a.completed} done` : null,
            a.blocked ? `${a.blocked} blocked` : null,
            a.added ? `${a.added} added` : null,
          ].filter(Boolean);
          return (
            <li key={a.actor_id ?? 'system'} className="text-xs text-neutral-text-primary">
              <span className="font-medium">{a.actor_username ?? 'Someone'}</span>
              <span className="text-neutral-text-secondary"> — {parts.join(' · ')}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BlockersRow({ blockers }: { blockers: SprintDailyDelta['new_blockers'] }) {
  return (
    <div className="px-3 py-2 flex flex-col gap-1">
      <span className="text-xs font-medium text-semantic-at-risk">
        <span aria-hidden="true">⚠ </span>New blockers ({blockers.length})
      </span>
      <ul className="flex flex-col gap-0.5">
        {blockers.map((b) => (
          <li key={b.task_id} className="text-sm flex items-center gap-2">
            <span className="tppm-mono text-xs text-neutral-text-secondary w-16 shrink-0">
              {b.task_short_id}
            </span>
            <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{b.task_title}</span>
            {b.actor_username && (
              <span className="text-xs text-neutral-text-disabled shrink-0">by {b.actor_username}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MovedRow({ changes }: { changes: SprintDailyDelta['task_changes'] }) {
  return (
    <div className="px-3 py-2 flex flex-col gap-1">
      <span className="text-xs text-neutral-text-secondary">Moved cards ({changes.length})</span>
      <ul className="flex flex-col gap-0.5">
        {changes.map((c, i) => (
          <li key={`${c.task_id}-${i}`} className="text-sm flex items-center gap-2">
            <span className="tppm-mono text-xs text-neutral-text-secondary w-16 shrink-0">
              {c.task_short_id}
            </span>
            <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{c.task_title}</span>
            <span className="text-xs text-neutral-text-secondary shrink-0">
              {statusLabel(c.from)} → {statusLabel(c.to)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScopeRow({ items }: { items: SprintDailyDelta['scope_added'] }) {
  return (
    <div className="px-3 py-2 flex flex-col gap-1">
      <span className="text-xs text-neutral-text-secondary">Scope added ({items.length})</span>
      <ul className="flex flex-col gap-0.5">
        {items.map((s, i) => (
          <li key={`${s.task_id ?? s.task_short_id}-${i}`} className="text-sm flex items-center gap-2">
            <span className="tppm-mono text-xs text-neutral-text-secondary w-16 shrink-0">
              {s.task_short_id}
            </span>
            <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{s.task_title}</span>
            {s.added_by_username && (
              <span className="text-xs text-neutral-text-disabled shrink-0">by {s.added_by_username}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "since 6:00 PM Mon" style hint — purely cosmetic, the server owns the window. */
function relativeSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `since ${d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}
