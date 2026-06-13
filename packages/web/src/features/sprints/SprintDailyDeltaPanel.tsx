import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSprintDailyDelta, type SprintDailyDelta } from '@/hooks/useSprints';
import { useScheduleStore } from '@/stores/scheduleStore';
import { blockerTypeLabel, formatBlockedAge } from '@/lib/blocker';
import { ScopeChangeDrawer } from './ScopeChangeDrawer';

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

/** The session-local "since" window options (#1123). */
type WindowMode = '24h' | '48h' | 'last_seen';

const WINDOW_OPTIONS: { mode: WindowMode; label: string }[] = [
  { mode: '24h', label: '24h' },
  { mode: '48h', label: '48h' },
  { mode: 'last_seen', label: 'Since I last looked' },
];

/** localStorage key for the per-sprint last-viewed timestamp (#1123). */
function lastSeenKey(sprintId: string): string {
  return `trueppm:daily-delta:lastSeen:${sprintId}`;
}

function readLastSeen(sprintId: string): string | null {
  try {
    return window.localStorage.getItem(lastSeenKey(sprintId));
  } catch {
    // Private-mode / disabled storage — degrade to "no stored timestamp".
    return null;
  }
}

function writeLastSeen(sprintId: string, iso: string): void {
  try {
    window.localStorage.setItem(lastSeenKey(sprintId), iso);
  } catch {
    // Storage unavailable — the window control still works for 24h/48h.
  }
}

/**
 * Daily standup surface (#925, ADR-0121) — the team's "what changed since
 * yesterday" on the active sprint. Pull-only (no notifications); bound entirely to
 * `GET /sprints/{id}/daily-delta/`. Status-level only — never hours/keystroke —
 * and team-private by membership (a PMO non-member can't reach the endpoint).
 *
 * The window control (#1123) is session-local: 24h/48h compute `since` client-side;
 * "Since I last looked" replays the gap since this user last opened the panel for
 * this sprint (stored per user+sprint in localStorage), then advances the stored
 * timestamp so the next visit shows the full new gap (e.g. Fri → Mon). No server
 * changes — the ADR-0119 membership/privacy model is untouched.
 */
export function SprintDailyDeltaPanel({ sprintId }: Props) {
  const [windowMode, setWindowMode] = useState<WindowMode>('24h');

  // The stored last-seen timestamp is captured ONCE on mount per sprint, so that
  // switching to "Since I last looked" replays the gap up to the moment the panel
  // opened — not a moving target as the post-load write below advances it.
  const [lastSeenAtMount, setLastSeenAtMount] = useState<string | null>(null);
  useEffect(() => {
    setLastSeenAtMount(readLastSeen(sprintId));
  }, [sprintId]);

  const since = useMemo<string | undefined>(() => {
    if (windowMode === '24h') return new Date(Date.now() - 24 * 3_600_000).toISOString();
    if (windowMode === '48h') return new Date(Date.now() - 48 * 3_600_000).toISOString();
    // last_seen — replay the stored gap; if we've never recorded one, fall back to
    // 24h so the option is never empty on first use.
    return lastSeenAtMount ?? new Date(Date.now() - 24 * 3_600_000).toISOString();
  }, [windowMode, lastSeenAtMount]);

  const query = useSprintDailyDelta(sprintId, { since });

  // After data loads, advance the stored last-viewed timestamp to "now" so the next
  // visit's "Since I last looked" shows everything since this view (#1123).
  const loadedUntil = query.data?.until;
  useEffect(() => {
    if (loadedUntil) writeLastSeen(sprintId, new Date().toISOString());
  }, [sprintId, loadedUntil]);

  const control = (
    <WindowControl mode={windowMode} onChange={setWindowMode} />
  );

  if (query.isLoading) {
    return (
      <section
        aria-labelledby="daily-delta-heading"
        data-testid="sprint-daily-delta"
        className="rounded-md border border-neutral-border bg-neutral-surface flex flex-col"
      >
        <PanelHeader control={control} subtitle={null} />
        <div className="h-24 m-2 rounded-md border border-neutral-border bg-neutral-surface-raised animate-pulse" />
      </section>
    );
  }

  // Explicit error state (#1128): a failed read must be distinguishable from a quiet
  // "nothing changed" — show a single Retry that re-runs the query.
  if (query.isError) {
    return (
      <section
        aria-labelledby="daily-delta-heading"
        data-testid="sprint-daily-delta"
        className="rounded-md border border-neutral-border bg-neutral-surface flex flex-col"
      >
        <PanelHeader control={control} subtitle={null} />
        <div role="alert" className="px-3 py-4 flex items-center justify-between gap-3 text-xs">
          <span className="text-semantic-at-risk">Couldn&apos;t load the delta.</span>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="rounded border border-neutral-border bg-neutral-surface-raised px-2 py-1 font-medium
              text-neutral-text-primary hover:border-brand-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  // Defensive: this panel lives inside the active-sprint view, so an unexpected
  // response shape must never blank the whole page — render nothing instead of
  // crashing on a missing array (e.g. a non-delta body from a lenient mock/proxy).
  if (!query.data || !Array.isArray(query.data.task_changes)) return null;

  const d = query.data;
  const empty =
    d.task_changes.length === 0 &&
    d.scope_added.length === 0 &&
    d.new_blockers.length === 0 &&
    d.burndown_delta == null;

  // "Last updated HH:MM" so a quiet panel reads as fresh, not stale/failed (#1128).
  const lastUpdated = formatClock(d.until) ?? formatClock(new Date(query.dataUpdatedAt).toISOString());

  return (
    <section
      aria-labelledby="daily-delta-heading"
      data-testid="sprint-daily-delta"
      className="rounded-md border border-neutral-border bg-neutral-surface flex flex-col"
    >
      <PanelHeader control={control} subtitle={relativeSince(d.since)} />

      {empty ? (
        <div className="px-3 py-4 flex flex-col gap-1">
          <p role="status" className="text-xs italic text-neutral-text-secondary">
            Nothing changed in this window.
          </p>
          {lastUpdated && (
            <p className="text-[10px] tppm-mono text-neutral-text-secondary">
              Last updated {lastUpdated}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-neutral-border">
          {d.burndown_delta && <BurndownRow delta={d.burndown_delta} />}
          {d.sprint_load && <SprintLoadRow load={d.sprint_load} />}
          <PerActorRow actors={d.per_actor} aggregate={d.actor_aggregate} />
          {d.new_blockers.length > 0 && (
            <BlockersRow blockers={d.new_blockers} summary={d.blocker_summary} />
          )}
          {d.task_changes.length > 0 && <MovedRow changes={d.task_changes} />}
          {d.scope_added.length > 0 && <ScopeRow items={d.scope_added} sprintId={sprintId} />}
          {lastUpdated && (
            <p className="px-3 py-1.5 text-[10px] tppm-mono text-neutral-text-secondary">
              Last updated {lastUpdated}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function PanelHeader({ control, subtitle }: { control: ReactNode; subtitle: string | null }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-neutral-border">
      <div className="flex items-baseline gap-2">
        <h3
          id="daily-delta-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Daily delta
        </h3>
        {subtitle && (
          <span className="text-[10px] tppm-mono text-neutral-text-secondary">{subtitle}</span>
        )}
      </div>
      {control}
    </header>
  );
}

/** Session-local window selector (#1123) — 24h / 48h / Since I last looked. */
function WindowControl({
  mode,
  onChange,
}: {
  mode: WindowMode;
  onChange: (mode: WindowMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Delta window"
      className="inline-flex rounded-md border border-neutral-border overflow-hidden text-[11px]"
    >
      {WINDOW_OPTIONS.map((opt) => {
        const active = opt.mode === mode;
        return (
          <button
            key={opt.mode}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.mode)}
            className={[
              'px-2 py-0.5 font-medium border-l border-neutral-border first:border-l-0',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset',
              active
                ? 'bg-brand-primary text-white'
                : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
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
  const ariaLabel = down
    ? `Remaining work down ${Math.abs(delta.remaining_delta)} points — on track`
    : delta.remaining_delta > 0
      ? `Remaining work up ${delta.remaining_delta} points — at risk`
      : 'Remaining work unchanged';
  return (
    <div className="px-3 py-2 text-sm flex items-center gap-2">
      <span className="text-xs text-neutral-text-secondary w-24 shrink-0">Burndown</span>
      <span className={`tppm-mono ${tone}`} aria-label={ariaLabel}>
        <span aria-hidden="true">{arrow} </span>
        {delta.remaining_delta > 0 ? '+' : ''}
        {delta.remaining_delta} pts remaining
      </span>
      <span className="text-xs text-neutral-text-secondary">
        ({delta.prior_remaining} → {delta.current_remaining}
        {delta.completed_delta > 0 && <>, +{delta.completed_delta} done</>})
      </span>
    </div>
  );
}

/** Sprint-load indicator (#1127): committed → current, Δ, and "now X% loaded". */
function SprintLoadRow({ load }: { load: SprintDailyDelta['sprint_load'] }) {
  // Velocity-gated: when the point figures are suppressed there is nothing to show.
  if (load.committed_points == null && load.current_points == null) return null;
  const committed = load.committed_points;
  const current = load.current_points;
  const delta = load.delta_points;
  const pct = load.pct_loaded != null ? Math.round(load.pct_loaded * 100) : null;
  const overloaded = pct != null && pct > 100;
  return (
    <div className="px-3 py-2 text-sm flex items-center gap-2">
      <span className="text-xs text-neutral-text-secondary w-24 shrink-0">Sprint load</span>
      <span className="tppm-mono text-neutral-text-primary">
        {committed ?? '—'} → {current ?? '—'}
        {delta != null && delta !== 0 && (
          <span className={delta > 0 ? 'text-semantic-at-risk' : 'text-semantic-on-track'}>
            {' '}
            (Δ {delta > 0 ? '+' : ''}
            {delta})
          </span>
        )}
      </span>
      {pct != null && (
        <span
          className={`text-xs ${overloaded ? 'text-semantic-at-risk' : 'text-neutral-text-secondary'}`}
        >
          now {pct}% loaded
        </span>
      )}
    </div>
  );
}

/**
 * Per-actor breakdown (#1126) — reframed anti-scoreboard. A framing line sits above
 * the list, the team aggregate leads, and each actor is a stacked non-tabular block
 * (no aligned columns) so it can't be read at a glance as a ranking. A Viewer-role
 * reader gets `actors == []` from the server and sees only the aggregate.
 */
function PerActorRow({
  actors,
  aggregate,
}: {
  actors: SprintDailyDelta['per_actor'];
  aggregate: SprintDailyDelta['actor_aggregate'];
}) {
  const aggParts = countParts(aggregate);
  return (
    <div className="px-3 py-2 flex flex-col gap-1.5">
      <h4 id="dd-actors" className="text-xs text-neutral-text-secondary font-normal">
        Activity since yesterday
      </h4>
      <p className="text-[10px] text-neutral-text-secondary italic">
        Status transitions since yesterday — to focus today&apos;s standup, not to compare
        contributors.
      </p>
      {aggParts.length > 0 && (
        <p className="text-xs text-neutral-text-primary">
          <span className="font-medium">Team</span>
          <span className="text-neutral-text-secondary"> — {aggParts.join(' · ')}</span>
        </p>
      )}
      {actors.length > 0 && (
        <ul aria-labelledby="dd-actors" className="flex flex-col gap-1">
          {actors.map((a) => {
            const parts = countParts(a);
            return (
              <li
                key={a.actor_id ?? 'system'}
                className="flex flex-col rounded bg-neutral-surface-raised px-2 py-1"
              >
                <span className="text-xs font-medium text-neutral-text-primary">
                  {a.actor_username ?? 'Someone'}
                </span>
                <span className="text-[11px] text-neutral-text-secondary">{parts.join(' · ')}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Shared count formatting for an actor or the team aggregate (#1126). */
function countParts(a: {
  moved: number;
  completed: number;
  blocked: number;
  added: number;
}): string[] {
  return [
    a.moved ? `${a.moved} moved` : null,
    a.completed ? `${a.completed} done` : null,
    a.blocked ? `${a.blocked} blocked` : null,
    a.added ? `${a.added} added` : null,
  ].filter((p): p is string => p !== null);
}

function BlockersRow({
  blockers,
  summary,
}: {
  blockers: SprintDailyDelta['new_blockers'];
  summary: SprintDailyDelta['blocker_summary'];
}) {
  // ADR-0124 (#1125): the standup splits new blockers into "impediment" (a
  // triageable blocker_type is recorded — the SM can route the unblock) vs
  // "paused" (a bare flag with no type). The headline counts come from the
  // server-computed summary so the split survives an empty list edge. The
  // free-text reason is NEVER in this payload — the standup is a shared screen.
  const headline =
    summary.impediment > 0 && summary.paused > 0
      ? `${summary.impediment} impediment, ${summary.paused} paused`
      : summary.impediment > 0
        ? `${summary.impediment} impediment`
        : `${summary.paused} paused`;
  return (
    <div className="px-3 py-2 flex flex-col gap-1">
      <h4 id="dd-blockers" className="text-xs font-medium text-semantic-at-risk">
        <span aria-hidden="true">⚠ </span>New blockers ({headline})
      </h4>
      <ul aria-labelledby="dd-blockers" className="flex flex-col gap-0.5">
        {blockers.map((b) => {
          const age = formatBlockedAge(b.blocked_age_seconds);
          const typeLabel = blockerTypeLabel(b.blocker_type);
          return (
            <li key={b.task_id} className="text-sm flex flex-wrap items-center gap-2">
              <TaskRef taskId={b.task_id} shortId={b.task_short_id} title={b.task_title} />
              <span
                className={[
                  'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-medium',
                  b.kind === 'impediment'
                    ? 'bg-semantic-at-risk-bg text-semantic-at-risk border border-semantic-at-risk/40'
                    : 'bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-border',
                ].join(' ')}
              >
                {b.kind === 'impediment' ? (typeLabel ?? 'Impediment') : 'Paused'}
              </span>
              {age && (
                <span className="text-xs text-neutral-text-secondary shrink-0 tppm-mono">{age}</span>
              )}
              {b.actor_username && (
                <span className="text-xs text-neutral-text-secondary shrink-0">
                  by {b.actor_username}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MovedRow({ changes }: { changes: SprintDailyDelta['task_changes'] }) {
  return (
    <div className="px-3 py-2 flex flex-col gap-1">
      <h4 id="dd-moved" className="text-xs text-neutral-text-secondary font-normal">
        Moved cards ({changes.length})
      </h4>
      <ul aria-labelledby="dd-moved" className="flex flex-col gap-0.5">
        {changes.map((c, i) => (
          <li key={`${c.task_id}-${i}`} className="text-sm flex items-center gap-2">
            <TaskRef taskId={c.task_id} shortId={c.task_short_id} title={c.task_title} />
            <span className="text-xs text-neutral-text-secondary shrink-0">
              {statusLabel(c.from)} → {statusLabel(c.to)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScopeRow({
  items,
  sprintId,
}: {
  items: SprintDailyDelta['scope_added'];
  sprintId: string;
}) {
  const [auditOpen, setAuditOpen] = useState(false);
  return (
    <div className="px-3 py-2 flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h4 id="dd-scope" className="text-xs text-neutral-text-secondary font-normal">
          Scope added ({items.length})
        </h4>
        {/* One-click into the existing mid-sprint scope audit (#1123) — reuses the
            Sprint-header ScopeChangeDrawer; never a duplicate drawer. */}
        <button
          type="button"
          onClick={() => setAuditOpen(true)}
          aria-haspopup="dialog"
          className="text-[11px] font-medium text-brand-primary hover:underline
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
        >
          View scope audit
        </button>
      </div>
      <ul aria-labelledby="dd-scope" className="flex flex-col gap-0.5">
        {items.map((s, i) => (
          <li
            key={`${s.task_id ?? s.task_short_id}-${i}`}
            className="text-sm flex items-center gap-2 flex-wrap"
          >
            <TaskRef taskId={s.task_id} shortId={s.task_short_id} title={s.task_title} />
            {s.epic && (
              <span className="rounded-full bg-brand-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-brand-primary shrink-0">
                {s.epic.name}
              </span>
            )}
            {s.story_points != null && (
              <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">
                +{s.story_points} pts
              </span>
            )}
            {s.added_by_username && (
              <span className="text-xs text-neutral-text-secondary shrink-0">
                by {s.added_by_username}
              </span>
            )}
          </li>
        ))}
      </ul>
      {auditOpen && <ScopeChangeDrawer sprintId={sprintId} onClose={() => setAuditOpen(false)} />}
    </div>
  );
}

/**
 * A clickable short-id + title that opens the in-context task drawer (#1124) by
 * setting the shared `selectedTaskId` the schedule/board drawer renders from. A row
 * with a null task_id (e.g. a scope change that never minted a task) stays inert.
 */
function TaskRef({
  taskId,
  shortId,
  title,
}: {
  taskId: string | null;
  shortId: string;
  title: string;
}) {
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const inner = (
    <>
      <span className="tppm-mono text-xs text-neutral-text-secondary w-16 shrink-0">{shortId}</span>
      <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{title}</span>
    </>
  );
  if (!taskId) {
    return <span className="flex items-center gap-2 flex-1 min-w-0">{inner}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => setSelectedTaskId(taskId)}
      className="flex items-center gap-2 flex-1 min-w-0 text-left rounded
        hover:text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      {inner}
    </button>
  );
}

/** "since 6:00 PM Mon" style hint — purely cosmetic, the server owns the window. */
function relativeSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `since ${d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

/** "HH:MM" local clock for the last-updated line (#1128). */
function formatClock(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
