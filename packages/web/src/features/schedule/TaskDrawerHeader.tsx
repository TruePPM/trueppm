import type { Task } from '@/types';

interface TaskDrawerHeaderProps {
  task: Task;
}

/** Format an ISO date string as "Apr 9" (current year) or "Apr 9, 2025" (other years). */
function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  const currentYear = new Date().getUTCFullYear();
  if (d.getUTCFullYear() === currentYear) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Derive initials from a display name ("Jane Smith" → "JS"). */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Header section rendered above the tab bar in TaskDetailDrawer.
 *
 * Shows three rows: owner (assignee + overalloc pill), dates
 * (early_start → early_finish + optional baseline), and float.
 */
export function TaskDrawerHeader({ task }: TaskDrawerHeaderProps) {
  const hasSchedule = !!task.start;
  const hasBaseline = !!task.baselineStart && !!task.baselineFinish;

  // Variance color for baseline date row
  const variance =
    hasBaseline && hasSchedule
      ? Math.round(
          (new Date(task.finish + 'T00:00:00Z').getTime() -
            new Date(task.baselineFinish! + 'T00:00:00Z').getTime()) /
            86_400_000,
        )
      : null;

  const varianceColor =
    variance === null
      ? ''
      : variance <= 0
        ? 'text-semantic-on-track'
        : variance <= 3
          ? 'text-semantic-at-risk'
          : 'text-semantic-critical';

  const varianceLabel =
    variance === null ? '' : variance > 0 ? `+${variance}d` : variance < 0 ? `${variance}d` : '0d';

  return (
    <div className="border-b border-neutral-border shrink-0">
      {/* Owner row */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-neutral-border/60">
        {task.assignees.length > 0 ? (
          <>
            <span
              className="w-8 h-8 rounded-full bg-sage-500 text-navy-900 dark:bg-sage-400 dark:text-navy-900 text-xs font-semibold
                flex items-center justify-center shrink-0 select-none"
              aria-hidden="true"
            >
              {getInitials(task.assignees[0].name)}
            </span>
            <span className="text-sm font-medium text-neutral-text-primary truncate flex-1 min-w-0">
              {task.assignees[0].name}
            </span>
            {task.assigneeIsOverallocated && (
              // Informational status chip — not interactive (no click/key action),
              // so it must not announce as a button. role="note" + aria-label carry
              // the meaning to AT; the title is the pointer-hover affordance.
              <span
                role="note"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs shrink-0
                  border border-semantic-at-risk/40 bg-semantic-at-risk-bg text-semantic-at-risk cursor-help"
                title="Sum of resource units across active tasks exceeds 1.0. Open the resource view to investigate."
                aria-label={`${task.assignees[0].name} is over-allocated across active tasks`}
              >
                ⚠ over-allocated
              </span>
            )}
          </>
        ) : (
          <>
            <span
              className="w-8 h-8 rounded-full border border-dashed border-neutral-border
                text-neutral-text-secondary text-xs font-semibold flex items-center justify-center
                shrink-0 select-none"
              aria-hidden="true"
            >
              ?
            </span>
            <span className="text-sm italic text-neutral-text-secondary">Unassigned</span>
          </>
        )}
      </div>

      {/* Date row */}
      <div className="px-5 py-3 border-b border-neutral-border/60 space-y-1">
        {hasSchedule ? (
          <>
            <div className="flex items-baseline gap-1.5">
              <span className="tppm-mono text-sm text-neutral-text-primary">
                {formatDate(task.start)} → {formatDate(task.finish)}
              </span>
              <span className="text-xs text-neutral-text-secondary">· {task.duration}d</span>
            </div>
            {hasBaseline && (
              <div className="flex items-baseline gap-1.5">
                <span className="tppm-mono text-xs text-neutral-text-secondary">
                  BL: {formatDate(task.baselineStart!)} → {formatDate(task.baselineFinish!)}
                </span>
                {varianceLabel && (
                  <span className={`tppm-mono text-xs font-medium ${varianceColor}`}>
                    {varianceLabel}
                  </span>
                )}
              </div>
            )}
          </>
        ) : (
          <span className="text-sm italic text-neutral-text-secondary">Not scheduled</span>
        )}
      </div>

      {/* Float row */}
      <div className="flex items-center gap-2 px-5 py-3">
        {task.totalFloat === null || task.totalFloat === undefined ? (
          <span className="text-sm italic text-neutral-text-secondary">
            Float pending — run scheduler
          </span>
        ) : task.isCritical ? (
          <>
            <span
              className="w-2 h-2 rounded-full bg-semantic-critical shrink-0"
              aria-hidden="true"
            />
            <span
              className="tppm-mono text-sm text-semantic-critical"
              title="This task is on the critical path — a delay here delays the project end date"
            >
              {task.totalFloat}d float
            </span>
            <span className="text-xs text-neutral-text-secondary">· critical path</span>
          </>
        ) : (
          <span className="tppm-mono text-sm text-neutral-text-primary">
            {task.totalFloat}d float
          </span>
        )}
      </div>
    </div>
  );
}
