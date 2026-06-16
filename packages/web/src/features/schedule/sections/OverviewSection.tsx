import { type ChangeEvent, useState } from 'react';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask, parseProgressAnchorError } from '@/hooks/useTaskMutations';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { canEditTask } from '@/lib/roles';
import type { TaskStatus } from '@/types';
import { ResourceAssignmentSection } from '../ResourceAssignmentSection';
import { BacklogDemoteConfirmDialog } from '../BacklogDemoteConfirmDialog';
import { ScopeChangedChip } from '@/features/sprints/ScopeChangedChip';

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
const DEMOTION_GUARD: ReadonlySet<TaskStatus> = new Set(['IN_PROGRESS', 'REVIEW', 'COMPLETE']);

/**
 * Overview — the always-open default section per ADR-0050.
 *
 * Composes description (placeholder until #305 lands), assignees, status
 * (editable select — #405), and progress (editable numeric input — #406).
 * Status changes fire PATCH immediately; progress is debounced on blur.
 * ADR-0057: demoting from IN_PROGRESS/REVIEW/COMPLETE → BACKLOG requires
 * confirmation via BacklogDemoteConfirmDialog.
 */
export function OverviewSection({ taskId, projectId, userRole, canEdit }: DrawerSectionProps) {
  const itl = useIterationLabel(projectId);
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  const { mutate: updateTask, isPending } = useUpdateTask();

  // ADR-0133/1142: gate every write control off the server-derived verdict the
  // drawer threads down; fall back to the client role rule only when it is absent.
  const editable = canEdit ?? canEditTask(userRole);

  // Local progress state so the input feels immediate before the blur PATCH.
  const [localProgress, setLocalProgress] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);

  // Pending BACKLOG demotion — set when user selects Backlog from a guarded status.
  const [pendingBacklog, setPendingBacklog] = useState(false);

  if (!task) return null;

  const progressDisplay =
    localProgress !== null ? localProgress : String(Math.round(task.progress));

  // Milestone with a live sprint rollup (ADR-0074): show locked, rolled-up
  // value instead of the editable input. Distinct from `task.isSummary` —
  // milestones are leaves, not summaries, so this branch is independent.
  const milestoneRollupActive = Boolean(
    task.isMilestone &&
    task.milestoneRollup &&
    task.milestoneRollup.rollup_basis !== 'none' &&
    task.milestoneRollup.percent_complete != null,
  );

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

  return (
    <div className="space-y-5">
      {pendingBacklog && (
        <BacklogDemoteConfirmDialog onConfirm={handleDemoteConfirm} onCancel={handleDemoteCancel} />
      )}

      {/* Description moved to the drawer-level Details tab as a deferred-save
          field (#962) — it is the one free-text field that stages edits behind
          the save bar; the rest of this section autosaves immediately. */}

      {/* Status + Progress — the work state, side by side per the #962 redesign.
          Both autosave immediately (status on change, progress on drag-release). */}
      <div className="flex gap-4">
        {/* Status — editable (#405) */}
        <div className="flex-1 min-w-0">
          <div className={LABEL_CLASS}>Status</div>
          {task.isSummary || !editable ? (
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

        {/* Progress — slider for leaf tasks, read-only for summary (#406)
         *   and for milestones with a sprint rollup (ADR-0074). */}
        <div className="flex-1 min-w-0">
          <div className={`${LABEL_CLASS} flex items-center justify-between gap-2`}>
            <span>
              {milestoneRollupActive
                ? `Progress (${itl.lower} rollup)`
                : task.isSummary
                  ? 'Progress (rolled up)'
                  : 'Progress'}
            </span>
            {/* Editable leaf tasks carry the value in the numeric input next to
                the slider; the header readout would just duplicate it. Read-only
                callers (summary/viewer) have no input, so keep the readout. */}
            {!milestoneRollupActive && !task.isSummary && !editable && (
              <span className="tppm-mono font-bold normal-case tracking-normal text-brand-primary">
                {progressDisplay}%
              </span>
            )}
          </div>
          {milestoneRollupActive && task.milestoneRollup ? (
            <MilestoneRollupReadOnly rollup={task.milestoneRollup} />
          ) : task.isSummary || !editable ? (
            <p className="text-sm tppm-mono text-neutral-text-primary">
              {Math.round(task.progress)}%
            </p>
          ) : (
            <div className="flex h-9 items-center gap-3">
              <input
                type="range"
                aria-label="Task progress percentage"
                min={0}
                max={100}
                step={1}
                value={Number(progressDisplay)}
                disabled={task.status === 'COMPLETE' || isPending}
                onChange={(e) => setLocalProgress(e.target.value)}
                onMouseUp={handleProgressBlur}
                onTouchEnd={handleProgressBlur}
                onKeyUp={handleProgressBlur}
                onBlur={handleProgressBlur}
                className={[
                  'w-full accent-brand-primary cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                ].join(' ')}
              />
              {/* Exact-value entry alongside the slider (issue 1047): the slider is
                  coarse for fine values like 83%; the numeric input sets any
                  integer 0–100. Both bind to the same localProgress, so they
                  stay in sync. handleProgressBlur clamps + commits the PATCH. */}
              <div className="flex shrink-0 items-center gap-1">
                <input
                  type="number"
                  aria-label="Task progress percent"
                  min={0}
                  max={100}
                  step={1}
                  value={progressDisplay}
                  disabled={task.status === 'COMPLETE' || isPending}
                  onChange={(e) => setLocalProgress(e.target.value)}
                  onBlur={handleProgressBlur}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  className={[
                    'w-14 h-8 rounded border border-neutral-border bg-neutral-surface px-2',
                    'text-sm tppm-mono text-right text-neutral-text-primary',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  ].join(' ')}
                />
                <span className="text-sm text-neutral-text-secondary" aria-hidden="true">
                  %
                </span>
              </div>
            </div>
          )}
          {task.status === 'COMPLETE' && !task.isSummary && !milestoneRollupActive && (
            <p className="mt-1 text-xs text-neutral-text-disabled">
              Zeroed automatically on Complete
            </p>
          )}
          {progressError && (
            <p role="alert" className="mt-1.5 text-xs text-semantic-critical">
              {progressError}
            </p>
          )}
        </div>
      </div>

      {/* People / assignees */}
      <ResourceAssignmentSection taskId={taskId} projectId={projectId} canEdit={editable} />
    </div>
  );
}

function MilestoneRollupReadOnly({
  rollup,
}: {
  rollup: NonNullable<ReturnType<typeof useScheduleTasks>['tasks']>[number]['milestoneRollup'];
}) {
  const itl = useIterationLabel();
  if (!rollup || rollup.percent_complete == null) return null;
  const pct = Math.round(rollup.percent_complete);
  const basis = rollup.rollup_basis === 'tasks' ? 'tasks' : 'points';
  const variance = rollup.variance_days;
  return (
    <div className="flex flex-col gap-1.5">
      <p
        className="text-sm tppm-mono text-neutral-text-primary"
        aria-readonly="true"
        aria-label={`Milestone progress ${pct} percent, rolled up from ${rollup.sprint_count} ${rollup.sprint_count === 1 ? itl.lower : itl.lowerPlural}`}
      >
        {pct}%
      </p>
      <p className="text-xs text-neutral-text-secondary">
        by {basis}
        {rollup.sprint_count > 1 ? ` across ${rollup.sprint_count} ${itl.lowerPlural}` : ''}
      </p>
      {rollup.sprint_scope_changed && rollup.scope_change_sprint_id && (
        <span className="mt-1 self-start">
          <ScopeChangedChip sprintId={rollup.scope_change_sprint_id} />
        </span>
      )}
      <p className="text-xs text-neutral-text-secondary flex items-start gap-1.5 mt-1">
        <span aria-hidden="true">🔒</span>
        <span>Progress rolls up from {itl.lower}(s) — close or unlink to edit.</span>
      </p>
      {variance != null && variance !== 0 && (
        <p
          className={[
            'text-xs tppm-mono',
            variance < 0
              ? 'text-semantic-on-track'
              : variance <= 5
                ? 'text-semantic-at-risk'
                : 'text-semantic-critical',
          ].join(' ')}
        >
          {variance < 0
            ? `${itl.singular} plan: ${variance}d ahead`
            : `${itl.singular} plan: +${variance}d slip`}
        </p>
      )}
    </div>
  );
}
