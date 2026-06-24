/**
 * My Work v2 right column — a method-adaptive stack beside the assigned-task
 * list. The v2 spec wants Agile → sprint/burndown and Waterfall/Hybrid →
 * critical-path mini. My Work is cross-program with no single methodology, so we
 * show whichever signals the user's data implies:
 *   - an "Active sprints" panel when the user has any active sprint (the agile
 *     signal), and
 *   - an "On the critical path" mini-list of the user's critical tasks (the
 *     waterfall signal).
 * Each panel self-suppresses when empty; the whole column self-suppresses when
 * neither has anything, so a sprintless / non-critical contributor sees the
 * single-column list with no empty rail.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { MyWorkTask, MyWorkActiveSprint } from '@/hooks/useMyWork';

const MAX_CRITICAL = 4;

function Panel({
  title,
  count,
  children,
}: {
  title: string;
  count: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-card border border-neutral-border bg-neutral-surface-raised">
      <header className="flex items-baseline justify-between gap-2 border-b border-neutral-border/60 px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary">
          {title}
        </h2>
        <span className="tppm-mono text-[11px] text-neutral-text-secondary">{count}</span>
      </header>
      {children}
    </section>
  );
}

export function MyWorkSideColumn({
  tasks,
  activeSprints,
}: {
  tasks: MyWorkTask[];
  activeSprints: MyWorkActiveSprint[];
}) {
  const criticalTasks = tasks.filter((t) => t.is_critical).slice(0, MAX_CRITICAL);
  const criticalTotal = tasks.filter((t) => t.is_critical).length;

  if (activeSprints.length === 0 && criticalTotal === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {activeSprints.length > 0 && (
        <Panel title="Active sprints" count={`${activeSprints.length}`}>
          <ul className="flex flex-col">
            {activeSprints.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 border-b border-neutral-border/40 px-4 py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-text-primary">
                    {s.name}
                  </p>
                  <p className="truncate text-xs text-neutral-text-secondary">
                    {s.project_name} · {s.task_count} task{s.task_count === 1 ? '' : 's'}
                  </p>
                </div>
                <span
                  className={[
                    'tppm-mono shrink-0 text-xs',
                    s.days_remaining <= 1 ? 'text-semantic-at-risk' : 'text-neutral-text-secondary',
                  ].join(' ')}
                  aria-label={`${s.days_remaining} day${s.days_remaining === 1 ? '' : 's'} remaining`}
                >
                  {s.days_remaining}d left
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {criticalTotal > 0 && (
        <Panel title="On the critical path" count={`${criticalTotal}`}>
          <ul className="flex flex-col">
            {criticalTasks.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 border-b border-neutral-border/40 px-4 py-2.5 last:border-b-0"
              >
                <span
                  className="shrink-0 text-sm leading-none text-semantic-critical"
                  title="On the critical path — a delay here delays the project end date"
                  aria-label="On the critical path"
                >
                  <span aria-hidden="true">⚠</span>
                </span>
                <Link
                  to={t.url}
                  className="min-w-0 flex-1 truncate rounded-control text-sm text-neutral-text-primary
                    hover:underline focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  {t.name}
                </Link>
              </li>
            ))}
          </ul>
          {criticalTotal > criticalTasks.length && (
            <p className="px-4 py-2 text-xs text-neutral-text-disabled">
              +{criticalTotal - criticalTasks.length} more
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
