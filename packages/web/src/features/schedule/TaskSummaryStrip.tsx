import type { ReactNode } from 'react';
import type { Task } from '@/types';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { TaskFlagsSection } from './TaskFlagsSection';

/**
 * At-a-glance summary strip for the task-detail drawer (#2315, revised #2424).
 *
 * The strip is the drawer's **read** surface; the sections below it are the
 * **edit** surface, and a value belongs to exactly one of them (#2424). Anything
 * editable is not here; anything here is not editable here.
 *
 * That rule is why Status and Finish left: both were rendered again as controls
 * roughly 150px below, and nothing in the layout said which copy was
 * authoritative, so both read as inputs and whichever the user did not touch
 * looked stale for a frame. Float left for the same reason — it lives in the
 * Schedule grid, where the other computed schedule values are.
 *
 * What stays is what is carried nowhere else in the drawer: the owner, and the
 * baseline comparison. WBS and recent changes are deliberately NOT here even
 * though they are read-only — the drawer header already renders the WBS code and
 * `DrawerRecentActivity` sits directly above this strip, so adding them would
 * reintroduce exactly the duplication this change removes.
 *
 * Color is never the only signal (web-rules 6/7/120): the variance chip pairs its
 * tint with a signed day count.
 */

/** Derive initials from a display name ("Jane Smith" → "JS"). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Finish-vs-baseline variance in whole days, or null when either end is absent. */
function computeVariance(task: Task): number | null {
  if (!task.finish || !task.baselineFinish) return null;
  return Math.round(
    (new Date(task.finish + 'T00:00:00Z').getTime() -
      new Date(task.baselineFinish + 'T00:00:00Z').getTime()) /
      86_400_000,
  );
}

/** Signed day label for a variance ("+2d" / "-1d" / "On baseline"). */
function varianceLabel(variance: number): string {
  if (variance > 0) return `+${variance}d`;
  if (variance < 0) return `${variance}d`;
  return 'On baseline';
}

/** Tint for a variance: sage on or ahead of baseline, amber for a short slip, red beyond. */
function varianceClass(variance: number): string {
  if (variance <= 0)
    return 'border-semantic-on-track/40 bg-semantic-on-track-bg text-semantic-on-track';
  if (variance <= 3)
    return 'border-semantic-at-risk/40 bg-semantic-at-risk-bg text-semantic-at-risk';
  return 'border-semantic-critical/40 bg-semantic-critical-bg text-semantic-critical';
}

function Overline({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-[.06em] text-neutral-text-secondary mb-1">
      {children}
    </div>
  );
}

function Cell({ label, first, children }: { label: string; first?: boolean; children: ReactNode }) {
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

function BaselineCell({ task }: { task: Task }) {
  const variance = computeVariance(task);
  if (variance === null) {
    return <span className="text-sm text-neutral-text-disabled">No baseline</span>;
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-chip border text-xs font-semibold ${varianceClass(variance)}`}
      title={`Baseline finish ${fmtUtcShort(task.baselineFinish)}`}
    >
      <span className="tppm-mono">{varianceLabel(variance)}</span>
    </span>
  );
}

export function TaskSummaryStrip({ task }: { task: Task }) {
  const owner = task.assignees?.[0];

  return (
    <div
      role="group"
      aria-label="Task summary"
      className="rounded-card border border-neutral-border bg-neutral-surface overflow-hidden"
    >
      {/* The pill states the contract the strip now keeps: everything below this
          header is a read of a value that is edited somewhere else. */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-neutral-border bg-neutral-surface-sunken">
        <span className="text-xs font-semibold uppercase tracking-[.06em] text-neutral-text-secondary">
          At a glance
        </span>
        <span className="inline-flex items-center px-1.5 py-px rounded-chip text-xs font-medium text-neutral-text-secondary border border-neutral-border">
          read only
        </span>
      </div>

      <div className="flex flex-wrap">
        <Cell label="Owner" first>
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

        <Cell label="Baseline">
          <BaselineCell task={task} />
        </Cell>
      </div>

      <TaskFlagsSection task={task} />
    </div>
  );
}
