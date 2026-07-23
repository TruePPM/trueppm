import type { ReactNode } from 'react';
import type { Task, TaskStatus } from '@/types';

/**
 * At-a-glance summary strip for the task-detail drawer (#2315, Task-Detail
 * Drawer v2). The "spine" of the redesign: one compact, labeled band at the top
 * of the Details tab carrying the facts every persona opens a task for — status,
 * owner, finish, and the risk flags (blocked / critical / float). It is pure
 * presentation over existing `Task` fields; the schedule *detail* (Start /
 * Finish / Duration / Float grid, the no-committed-start advisory) stays in
 * `TaskScheduleStrip` (#2312), which this sits above.
 *
 * Color is never the only signal (web-rules 6/7/120): every status dot and every
 * flag chip is paired with its word.
 */

/** Status label + dot health color. Color reinforces the always-present word. */
const STATUS_META: Record<TaskStatus, { label: string; dot: string }> = {
  BACKLOG: { label: 'Backlog', dot: 'bg-neutral-text-disabled' },
  NOT_STARTED: { label: 'Not started', dot: 'bg-neutral-text-disabled' },
  IN_PROGRESS: { label: 'In progress', dot: 'bg-neutral-text-primary' },
  REVIEW: { label: 'In review', dot: 'bg-semantic-at-risk' },
  ON_HOLD: { label: 'On hold', dot: 'bg-neutral-text-disabled' },
  COMPLETE: { label: 'Complete', dot: 'bg-semantic-on-track' },
};

/** Format an ISO calendar date ("2026-07-23" → "Jul 23"), UTC-pinned so the
 *  rendered day never drifts by a viewer's timezone offset (web-rule 257). */
function formatFinish(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  const currentYear = new Date().getUTCFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getUTCFullYear() === currentYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

/** Derive initials from a display name ("Jane Smith" → "JS"). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Overline({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wider text-neutral-text-secondary mb-1">
      {children}
    </div>
  );
}

function Cell({
  label,
  first,
  children,
}: {
  label: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`flex-1 min-w-0 px-3 py-2.5 ${first ? '' : 'border-l border-neutral-border'}`}
    >
      <Overline>{label}</Overline>
      <div className="flex items-center gap-1.5 min-h-5">{children}</div>
    </div>
  );
}

export function TaskSummaryStrip({ task }: { task: Task }) {
  const meta = STATUS_META[task.status] ?? STATUS_META.NOT_STARTED;
  const owner = task.assignees?.[0];
  const hasSchedule = !!task.finish;
  const isCritical = task.isCritical;
  // Human blocker flag (blockedReason) OR dependency-readiness blocked (isBlocked).
  const blocked = !!task.blockedReason || !!task.isBlocked;
  const float = task.totalFloat;

  return (
    <div
      role="group"
      aria-label="Task summary"
      className="rounded-card border border-neutral-border bg-neutral-surface overflow-hidden"
    >
      {/* primary facts */}
      <div className="flex flex-wrap">
        <Cell label="Status" first>
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-text-primary">
            <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} aria-hidden="true" />
            {meta.label}
          </span>
        </Cell>

        <Cell label="Owner">
          {owner ? (
            <span className="inline-flex items-center gap-1.5 min-w-0">
              <span
                className="w-5 h-5 rounded-full bg-sage-500 text-navy-900 dark:bg-sage-400 text-[10px] font-semibold
                  inline-flex items-center justify-center shrink-0 select-none"
                aria-hidden="true"
              >
                {initials(owner.name)}
              </span>
              <span className="text-sm font-medium text-neutral-text-primary truncate">
                {owner.name}
              </span>
              {task.assigneeIsOverallocated && (
                <span
                  role="note"
                  className="inline-flex items-center px-1.5 py-px rounded-chip text-xs font-medium shrink-0
                    border border-semantic-at-risk/40 bg-semantic-at-risk-bg text-semantic-at-risk"
                  title="Sum of resource units across active tasks exceeds 1.0. Open the resource view to investigate."
                  aria-label={`${owner.name} is over-allocated across active tasks`}
                >
                  over-allocated
                </span>
              )}
            </span>
          ) : (
            <span className="text-sm text-neutral-text-secondary">Unassigned</span>
          )}
        </Cell>

        <Cell label={isCritical ? 'Target finish' : 'Finish'}>
          {hasSchedule ? (
            <span className="tppm-mono text-sm font-semibold text-neutral-text-primary">
              {formatFinish(task.finish)}
            </span>
          ) : (
            <span className="text-sm text-neutral-text-disabled">—</span>
          )}
        </Cell>
      </div>

      {/* flags row — color is never the only signal (rule 6/120): word + chip */}
      <div
        className={`flex items-center gap-2 flex-wrap px-3 py-2 border-t border-neutral-border ${
          blocked || isCritical ? 'bg-semantic-critical-bg' : 'bg-neutral-surface-sunken'
        }`}
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-text-secondary mr-0.5">
          Flags
        </span>
        {blocked && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-semibold text-white bg-semantic-critical">
            Blocked
          </span>
        )}
        {isCritical ? (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-semibold
              border border-semantic-critical/40 bg-semantic-critical-bg text-semantic-critical"
            title="On the critical path — slipping this moves the project finish."
          >
            Critical · 0d float
          </span>
        ) : (
          float !== null &&
          float !== undefined && (
            <span className="tppm-mono text-xs text-neutral-text-secondary">{float}d float</span>
          )
        )}
        {!blocked && !isCritical && (float === null || float === undefined) && (
          <span className="text-xs text-neutral-text-disabled">None</span>
        )}
      </div>
    </div>
  );
}
