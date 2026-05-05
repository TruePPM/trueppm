import type { ReactNode } from 'react';
import type { Task } from '@/types';
import { isTaskScheduled } from '@/lib/task';
import { formatShortDate } from '@/features/schedule/scheduleUtils';

export interface CardPopoverBodyAProps {
  task: Task;
  /** Resolved sprint name for the chip — null when the task has no sprint. */
  sprintName: string | null;
}

const STATUS_LABEL: Record<Task['status'], string> = {
  BACKLOG: 'Backlog',
  NOT_STARTED: 'To Do',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Review',
  ON_HOLD: 'On hold',
  COMPLETE: 'Complete',
};

function statusDotClass(status: Task['status']): string {
  switch (status) {
    case 'COMPLETE':
      return 'bg-semantic-on-track';
    case 'IN_PROGRESS':
      return 'bg-brand-primary';
    case 'REVIEW':
      return 'bg-semantic-at-risk';
    case 'BACKLOG':
      return 'bg-neutral-text-disabled';
    case 'ON_HOLD':
      return 'bg-neutral-text-secondary';
    case 'NOT_STARTED':
    default:
      return 'bg-neutral-text-secondary';
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface MetaRowProps {
  label: string;
  children: ReactNode;
}

function MetaRow({ label, children }: MetaRowProps) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <div className="text-xs text-neutral-text-secondary w-20 shrink-0 pt-px">{label}</div>
      <div className="flex-1 min-w-0 text-[13px] text-neutral-text-primary">{children}</div>
    </div>
  );
}

/**
 * Variation A body — structured rows. Picked over variation B per ux-design
 * (issue #304); B's hero/dep-list/Move surface is deferred to a follow-up.
 *
 * The component is presentational: footer actions live in
 * `CardPopoverFooter`, the shell (anchored vs. bottom-sheet) is supplied by
 * `CardPopoverShell`. This split lets `ux-design` swap variations with a
 * single body import in `index.tsx`.
 */
export function CardPopoverBodyA({ task, sprintName }: CardPopoverBodyAProps) {
  const scheduled = isTaskScheduled(task);
  const showCp = task.isCritical && scheduled;
  // Float chip is meaningful only on scheduled tasks (#332). CP tasks render
  // a "0d float — on critical path" red chip; non-CP tasks render a neutral
  // chip when totalFloat is set; otherwise the row is suppressed.
  const showFloat = scheduled && (task.isCritical
    || (task.totalFloat !== undefined && task.totalFloat !== null));
  const floatDays = task.isCritical ? 0 : (task.totalFloat ?? 0);
  const accentClass = showCp ? 'bg-semantic-critical' : 'bg-brand-primary';

  return (
    <>
      {/* Left accent bar — decorative; CP signal is repeated in the chip row + Float row */}
      <div
        aria-hidden="true"
        className={`absolute left-0 top-0 bottom-0 w-[3px] ${accentClass}`}
      />

      {/* Header */}
      <div className="pt-3.5 pr-4 pb-2.5 pl-[18px]">
        <div className="flex items-center gap-2 flex-wrap">
          {task.readiness && <ReadinessChip readiness={task.readiness} />}
          {showCp && (
            <span
              className="inline-flex items-center px-1 py-px rounded text-xs text-white bg-semantic-critical font-bold"
              aria-label="On critical path"
            >
              CP
            </span>
          )}
          {sprintName && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded border border-brand-primary/40 bg-transparent text-brand-primary text-[11px] font-medium"
              title={`Sprint: ${sprintName}`}
            >
              <span className="truncate max-w-[14ch]">Sprint: {sprintName}</span>
            </span>
          )}
          <span className="flex-1" />
          {task.wbs && (
            <span className="tppm-mono text-[11px] text-neutral-text-disabled">
              WBS {task.wbs}
            </span>
          )}
        </div>
        <h3
          id={`card-popover-title-${task.id}`}
          className="text-base font-semibold leading-snug text-neutral-text-primary mt-1.5 mb-0 line-clamp-2"
          title={task.name}
        >
          {task.name}
        </h3>
      </div>

      {/* Progress */}
      <div className="px-4 pb-3.5 pl-[18px]">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-neutral-text-secondary">Progress</span>
          <span className="tppm-mono text-xs font-medium text-neutral-text-primary">
            {task.progress}%
          </span>
        </div>
        <div className="h-1 rounded-full bg-neutral-surface-sunken overflow-hidden" aria-hidden="true">
          <div
            className={`h-full ${showCp ? 'bg-semantic-critical' : 'bg-brand-primary'}`}
            style={{ width: `${task.progress}%` }}
          />
        </div>
      </div>

      {/* Meta rows */}
      <div className="px-4 pb-2 pl-[18px]">
        <MetaRow label="Status">
          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-neutral-surface-sunken text-xs font-medium text-neutral-text-primary"
            aria-label={`Status: ${STATUS_LABEL[task.status]}`}
          >
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full ${statusDotClass(task.status)}`}
            />
            {STATUS_LABEL[task.status]}
          </span>
        </MetaRow>

        <MetaRow label="Dates">
          {scheduled ? (
            <span>
              <span className="tppm-mono text-[13px]">
                {formatShortDate(task.start)}
                <span className="text-neutral-text-disabled mx-1">→</span>
                {formatShortDate(task.finish)}
              </span>
              <span className="text-xs text-neutral-text-disabled ml-2">
                · <span className="tppm-mono">{task.duration}d</span>
              </span>
            </span>
          ) : (
            <span className="text-xs italic text-neutral-text-disabled">Not scheduled</span>
          )}
        </MetaRow>

        {showFloat && (
          <MetaRow label="Float">
            {showCp ? (
              <span className="inline-flex items-center px-1.5 py-px rounded tppm-mono text-xs bg-semantic-critical-bg text-semantic-critical">
                0d float — on critical path
              </span>
            ) : (
              <span className="tppm-mono text-xs text-neutral-text-secondary">{floatDays}d float</span>
            )}
          </MetaRow>
        )}

        <MetaRow label="Assignees">
          {task.assignees.length === 0 ? (
            <span className="text-xs italic text-neutral-text-disabled">Unassigned</span>
          ) : (
            <div className="flex gap-1 flex-wrap">
              {task.assignees.map((a) => (
                <span
                  key={a.resourceId}
                  className="inline-flex items-center px-1 py-px rounded text-xs text-white bg-brand-primary font-bold"
                  title={`${a.name} (${Math.round(a.units * 100)}%)`}
                  aria-label={a.name}
                >
                  {initials(a.name)}
                </span>
              ))}
            </div>
          )}
        </MetaRow>
      </div>
    </>
  );
}

interface ReadinessChipProps {
  readiness: NonNullable<Task['readiness']>;
}

// Local copy of the BoardCard readiness chip — kept in sync visually so the
// popover header reads as a continuation of the originating card. Variants
// are deliberately identical to BoardCard.tsx's local ReadinessChip; if a
// shared component is extracted later, both call sites switch in one diff.
function ReadinessChip({ readiness }: ReadinessChipProps) {
  switch (readiness) {
    case 'idea':
      return (
        <span className="inline-flex items-center px-1.5 py-px rounded border border-dashed border-neutral-border text-xs text-neutral-text-disabled">
          idea
        </span>
      );
    case 'estimated':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-neutral-surface-sunken border border-neutral-border text-xs text-neutral-text-secondary">
          <span aria-hidden="true">·</span> estimated
        </span>
      );
    case 'ready':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-brand-primary/10 dark:bg-semantic-on-track/10 border border-brand-primary/30 dark:border-semantic-on-track/30 text-xs text-brand-primary dark:text-semantic-on-track font-medium">
          <span aria-hidden="true">⛓</span> ready
        </span>
      );
    case 'baselined':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-neutral-surface-sunken border border-neutral-border text-xs text-neutral-text-secondary font-medium">
          <span aria-hidden="true">🔒</span> baselined
        </span>
      );
  }
}
