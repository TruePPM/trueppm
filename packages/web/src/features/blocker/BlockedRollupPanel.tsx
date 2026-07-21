import { WarningIcon } from '@/components/Icons';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';

import { blockerTypeLabel, formatBlockedAge } from '@/lib/blocker';
import {
  isImpediment,
  useProjectBlocked,
  useSprintBlocked,
  type BlockedRow,
} from '@/hooks/useBlockedRollup';

type Props =
  | { scope: 'project'; projectId: string }
  // Sprint scope carries `projectId` too (both live under /projects/:projectId)
  // so blocked rows can deep-link into the task drawer (issue #2159).
  | { scope: 'sprint'; sprintId: string; projectId: string };

type SprintGroup = 'all' | 'impediment' | 'paused';

/** Task-drawer route (mirrors ProjectOverviewPage's Attention rows, issue #2159). */
function taskDetailPath(projectId: string, taskId: string): string {
  return `/projects/${projectId}/tasks/${taskId}`;
}

/**
 * Blocked-task roll-up panel (ADR-0124) — the read-only triage surface for the
 * people who clear blockers (the web half). Lists flagged-blocked tasks
 * oldest-first with type + age + actor + assignee + the soft "waiting on" link.
 * The private free-text reason is never shown here — this is an escalation
 * surface, not a place to read contributor voice (it lives on the task drawer,
 * gated to the assignee + @-mentioned).
 *
 * Project scope backs the PM roll-up; sprint scope backs the SM impediment list
 * and surfaces the impediment-vs-paused split (impediment = a structured type is
 * set; paused = a bare flag).
 */
export function BlockedRollupPanel(props: Props) {
  // Both hooks are called unconditionally (rules of hooks); the inactive one is
  // disabled via its `enabled` guard and stays idle.
  const projectQuery = useProjectBlocked(props.scope === 'project' ? props.projectId : undefined);
  const sprintQuery = useSprintBlocked(props.scope === 'sprint' ? props.sprintId : undefined);
  const query = props.scope === 'project' ? projectQuery : sprintQuery;

  const rows = useMemo(() => query.data?.blocked ?? [], [query.data]);
  const count = query.data?.count ?? 0;

  const [open, setOpen] = useState(true);
  const [group, setGroup] = useState<SprintGroup>('all');

  const impedimentCount = useMemo(() => rows.filter(isImpediment).length, [rows]);
  const pausedCount = rows.length - impedimentCount;

  const visibleRows = useMemo(() => {
    if (props.scope !== 'sprint' || group === 'all') return rows;
    return rows.filter((r) => (group === 'impediment' ? isImpediment(r) : !isImpediment(r)));
  }, [rows, group, props.scope]);

  const title = props.scope === 'project' ? 'Blocked' : 'Impediments & paused';
  const isSprint = props.scope === 'sprint';

  // Open by default — a zero panel shows the reassuring "no blockers" state (a
  // good standup outcome), and the user can collapse the header to hide it.
  const expanded = open;

  return (
    <section
      aria-label={title}
      className="rounded-card border border-neutral-border bg-neutral-surface"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-4 py-3 text-left
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <span className="text-sm font-semibold text-neutral-text-primary">{title}</span>
        <span className="tppm-mono text-xs text-neutral-text-secondary">({count})</span>
        {isSprint && count > 0 && (
          <span className="text-xs text-neutral-text-secondary">
            <WarningIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />
            {`${impedimentCount} impediment${impedimentCount === 1 ? '' : 's'} · ${pausedCount} paused`}
          </span>
        )}
        <span className="ml-auto text-xs text-neutral-text-secondary">oldest first</span>
      </button>

      {expanded && (
        <div className="border-t border-neutral-border px-2 pb-2">
          {/* Sprint group toggle — client-side (server-side filters are a follow-up). */}
          {isSprint && count > 0 && (
            <div role="group" aria-label="Filter blocked tasks" className="flex gap-1 px-2 py-2">
              {(['all', 'impediment', 'paused'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGroup(g)}
                  aria-pressed={group === g}
                  className={`rounded-chip px-2 py-0.5 text-xs capitalize
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ${
                      group === g
                        ? 'bg-brand-primary/10 text-brand-primary'
                        : 'text-neutral-text-secondary'
                    }`}
                >
                  {g === 'all' ? 'All' : g === 'impediment' ? 'Impediments' : 'Paused'}
                </button>
              ))}
            </div>
          )}

          {query.isLoading ? (
            <ul className="space-y-1 px-2 py-1" aria-label="Loading blocked tasks">
              {[1, 2].map((i) => (
                <li key={i} className="h-10 motion-safe:animate-pulse rounded bg-neutral-surface-sunken" aria-hidden="true" />
              ))}
            </ul>
          ) : count === 0 ? (
            <p role="status" className="px-3 py-6 text-center text-sm text-neutral-text-secondary">
              No blocked tasks 🎉 — when someone flags a blocker it shows here, oldest first.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-border">
              {visibleRows.map((row) => (
                <BlockedRowItem key={row.task_id} row={row} projectId={props.projectId} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** Escalation color for the age: red ≥5d, amber ≥2d, neutral otherwise. The
 *  text label carries the value, so color is reinforcement (WCAG 1.4.1). */
function ageColorClass(ageSeconds: number | null): string {
  if (ageSeconds == null) return 'text-neutral-text-secondary';
  const days = ageSeconds / 86400;
  if (days >= 5) return 'text-semantic-critical';
  if (days >= 2) return 'text-semantic-at-risk';
  return 'text-neutral-text-secondary';
}

function BlockedRowItem({ row, projectId }: { row: BlockedRow; projectId: string }) {
  const typeLabel = blockerTypeLabel(row.blocker_type);
  const age = formatBlockedAge(row.blocked_age_seconds);
  return (
    <li className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
      {/* The whole title cell (short-id + title) opens the task drawer (issue
          #2159) so a triage reader can act on a blocker without hunting for it
          on another surface — mirrors the ProjectOverviewPage Attention rows'
          taskDetailPath, and stays a full-width `flex-1` link so the tap target
          spans the row rather than only the title glyphs. */}
      <Link
        to={taskDetailPath(projectId, row.task_id)}
        className="-my-1 min-w-0 flex-1 truncate rounded-control py-1 text-sm text-neutral-text-primary
          hover:text-brand-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        {row.task_short_id && (
          <span className="tppm-mono mr-1.5 text-xs text-neutral-text-secondary">
            {row.task_short_id}
          </span>
        )}
        {row.title}
      </Link>
      <span className="flex shrink-0 flex-wrap items-center gap-2">
        {typeLabel && (
          <span className="rounded-chip bg-neutral-surface-sunken px-1.5 py-0.5 text-xs text-neutral-text-secondary">
            {typeLabel}
          </span>
        )}
        {age && <span className={`tppm-mono text-xs ${ageColorClass(row.blocked_age_seconds)}`}>{age}</span>}
        {row.assignee && (
          <span className="text-xs text-neutral-text-secondary">{row.assignee.username}</span>
        )}
        {row.blocking_task && (
          // Soft "waiting on" link (issue 1156) — informational, NOT a CPM edge. Frame
          // it as "waiting on" (no arrow glyph that mimics a dependency) and spell
          // out the non-scheduling nature in the title so it can't read as a predecessor.
          // The short-id now deep-links to the blocking task (issue #2159) so the
          // triage reader can open what a task is waiting on, still within the project.
          <span
            className="text-xs text-neutral-text-secondary"
            title={`Waiting on ${row.blocking_task.title} — informational, does not affect the schedule`}
          >
            waiting on{' '}
            <Link
              to={taskDetailPath(projectId, row.blocking_task.id)}
              // Explicit accessible name — in a screen-reader links list the bare
              // short-id ("T-9") loses the "waiting on" context that only reads in
              // linear order, so name the destination as one action (#2159).
              aria-label={`Waiting on ${row.blocking_task.short_id || 'a task'}. View task.`}
              className="rounded-control underline-offset-2 hover:text-brand-primary hover:underline
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {row.blocking_task.short_id || 'a task'}
            </Link>
          </span>
        )}
      </span>
    </li>
  );
}
