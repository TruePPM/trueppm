import type { Task } from '@/types';
import { initials } from './cardFormat';

const AVATAR_CLASS =
  'inline-block px-1 py-px rounded-chip text-xs text-brand-primary bg-brand-primary/10 font-bold';

interface AssigneeChipProps {
  assignee: Task['assignees'][number];
  /** Peak overallocation factor for this resource across the task window (>1.0), if any. */
  overFactor: number | undefined;
  isDetailed: boolean;
}

function AssigneeChip({ assignee, overFactor, isDetailed }: AssigneeChipProps) {
  // The overallocation tooltip states the calendar-exception caveat explicitly:
  // the factor is a peak over the task window, not a calendar-aware capacity check.
  const tooltip = overFactor
    ? `${assignee.name} — ${overFactor.toFixed(1)}× allocated during this task ` +
      `(calendar exceptions not applied)`
    : `${assignee.name} (${Math.round(assignee.units * 100)}%)`;
  return (
    <span className="relative inline-block" title={tooltip}>
      <span
        className={AVATAR_CLASS}
        aria-label={overFactor ? `${assignee.name}, overallocated` : assignee.name}
      >
        {initials(assignee.name)}
      </span>
      {overFactor && (
        <>
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-semantic-critical border border-neutral-surface"
          />
          {isDetailed && (
            <span className="ml-1 inline-flex items-center gap-0.5 text-xs px-1 py-px rounded-chip border bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical tppm-mono">
              {overFactor.toFixed(1)}×
            </span>
          )}
        </>
      )}
    </span>
  );
}

interface CardAssigneesProps {
  task: Task;
  isIdea: boolean;
  isDetailed: boolean;
  overallocByResource?: Map<string, number>;
}

/**
 * Assignee initials row. An idea (uncommitted backlog card) shows a dashed "?"
 * placeholder instead — it is deliberately unassigned, not missing data.
 * Detailed density shows every assignee; comfortable caps at 3 plus a +N pill.
 */
export function CardAssignees({
  task,
  isIdea,
  isDetailed,
  overallocByResource,
}: CardAssigneesProps) {
  if (isIdea) {
    return (
      <span
        className="inline-block w-5 h-5 rounded-full border border-dashed border-neutral-border
                  flex items-center justify-center text-xs text-neutral-text-secondary"
        aria-label="Unassigned"
      >
        ?
      </span>
    );
  }
  const visible = isDetailed ? task.assignees : task.assignees.slice(0, 3);
  const hiddenCount = isDetailed ? 0 : Math.max(0, task.assignees.length - 3);
  return (
    <>
      {visible.map((a) => (
        <AssigneeChip
          key={a.resourceId}
          assignee={a}
          overFactor={overallocByResource?.get(a.resourceId)}
          isDetailed={isDetailed}
        />
      ))}
      {hiddenCount > 0 && (
        <span className={AVATAR_CLASS} aria-hidden="true">
          +{hiddenCount}
        </span>
      )}
    </>
  );
}
