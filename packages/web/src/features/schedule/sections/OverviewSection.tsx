import { type ChangeEvent, useState } from 'react';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask, parseProgressAnchorError } from '@/hooks/useTaskMutations';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import type { TaskStatus } from '@/types';
import { ResourceAssignmentSection } from '../ResourceAssignmentSection';
import { BacklogDemoteConfirmDialog } from '../BacklogDemoteConfirmDialog';

const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: 'BACKLOG', label: 'Backlog' },
  { value: 'NOT_STARTED', label: 'Not started' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'REVIEW', label: 'In review' },
  { value: 'COMPLETE', label: 'Complete' },
];

const LABEL_CLASS =
  'text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2';

const SELECT_CLASS =
  'w-full h-9 rounded border border-neutral-border bg-neutral-surface px-3 ' +
  'text-sm text-neutral-text-primary ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

/** Statuses that require a BacklogDemoteConfirmDialog before demoting to BACKLOG. */
const DEMOTION_GUARD: ReadonlySet<TaskStatus> = new Set([
  'IN_PROGRESS',
  'REVIEW',
  'COMPLETE',
]);

/**
 * Overview — the always-open default section per ADR-0050.
 *
 * Composes description (placeholder until #305 lands), assignees, status
 * (editable select — #405), and progress (editable numeric input — #406).
 * Status changes fire PATCH immediately; progress is debounced on blur.
 * ADR-0057: demoting from IN_PROGRESS/REVIEW/COMPLETE → BACKLOG requires
 * confirmation via BacklogDemoteConfirmDialog.
 */
export function OverviewSection({ taskId, projectId }: DrawerSectionProps) {
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  const { mutate: updateTask, isPending } = useUpdateTask();

  // Local progress state so the input feels immediate before the blur PATCH.
  const [localProgress, setLocalProgress] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);

  // Pending BACKLOG demotion — set when user selects Backlog from a guarded status.
  const [pendingBacklog, setPendingBacklog] = useState(false);

  if (!task) return null;

  const progressDisplay =
    localProgress !== null ? localProgress : String(Math.round(task.progress));

  function handleStatusChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as TaskStatus;
    if (next === 'BACKLOG' && DEMOTION_GUARD.has(task!.status)) {
      setPendingBacklog(true);
      return;
    }
    updateTask({ id: taskId, projectId, status: next });
  }

  function handleDemoteConfirm() {
    setPendingBacklog(false);
    updateTask({ id: taskId, projectId, status: 'BACKLOG' });
  }

  function handleDemoteCancel() {
    setPendingBacklog(false);
  }

  function handleProgressBlur() {
    if (localProgress === null) return;
    const parsed = parseInt(localProgress, 10);
    if (isNaN(parsed)) {
      setLocalProgress(null);
      return;
    }
    const clamped = Math.max(0, Math.min(100, parsed));
    setLocalProgress(null);
    setProgressError(null);
    updateTask(
      { id: taskId, projectId, percent_complete: clamped },
      {
        onError: (err) => {
          if (parseProgressAnchorError(err)) {
            setProgressError(
              `Set a Planned Start date (or assign a sprint) before recording progress.`,
            );
          }
        },
      },
    );
  }

  // Description field is not yet exposed on the Task type — wired in a
  // follow-up MR alongside the API mapping (`notes` exists on the backend
  // model). Until then the placeholder keeps the section's structure stable.
  const description: string | undefined = undefined;

  return (
    <div className="space-y-5">
      {pendingBacklog && (
        <BacklogDemoteConfirmDialog
          onConfirm={handleDemoteConfirm}
          onCancel={handleDemoteCancel}
        />
      )}

      {/* Description */}
      <div>
        <div className={LABEL_CLASS}>Description</div>
        {description ? (
          <p className="text-sm leading-relaxed text-neutral-text-primary whitespace-pre-wrap">
            {description}
          </p>
        ) : (
          <p className="text-sm italic text-neutral-text-secondary">No description.</p>
        )}
      </div>

      {/* Assignees */}
      <ResourceAssignmentSection taskId={taskId} projectId={projectId} />

      {/* Status — editable (#405) */}
      <div>
        <div className={LABEL_CLASS}>Status</div>
        {task.isSummary ? (
          <p className="text-sm text-neutral-text-primary">
            {STATUS_OPTIONS.find((o) => o.value === task.status)?.label ?? task.status}
          </p>
        ) : (
          <select
            aria-label="Task status"
            value={task.status}
            onChange={handleStatusChange}
            disabled={isPending}
            className={SELECT_CLASS}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Progress — editable for leaf tasks, read-only for summary (#406) */}
      <div>
        <div className={LABEL_CLASS}>
          {task.isSummary ? 'Progress (rolled up)' : 'Progress'}
        </div>
        {task.isSummary ? (
          <p className="text-sm tppm-mono text-neutral-text-primary">
            {Math.round(task.progress)}%
          </p>
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              aria-label="Task progress percentage"
              min={0}
              max={100}
              step={1}
              value={progressDisplay}
              disabled={task.status === 'COMPLETE' || isPending}
              onChange={(e) => setLocalProgress(e.target.value)}
              onBlur={handleProgressBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              className={[
                'w-16 h-9 rounded border border-neutral-border bg-neutral-surface px-3',
                'text-sm tppm-mono text-right text-neutral-text-primary',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              ].join(' ')}
            />
            <span className="text-sm text-neutral-text-secondary">%</span>
            {task.status === 'COMPLETE' && (
              <span className="text-xs text-neutral-text-disabled">
                (zeroed automatically on Complete)
              </span>
            )}
          </div>
        )}
        {progressError && (
          <p role="alert" className="mt-1.5 text-xs text-semantic-critical">
            {progressError}
          </p>
        )}
      </div>
    </div>
  );
}
