import { useEffect, useRef, useState } from 'react';
import type { EstimationMode, Task } from '@/types';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useApproveEstimates } from '@/hooks/useApproveEstimates';

interface EstimatesTabProps {
  task: Task;
  projectId: string;
  estimationMode: EstimationMode;
  userIsScheduler: boolean;
  /** Whether the task's sprint is currently ACTIVE — gates remaining-points edit. */
  sprintIsActive?: boolean;
}

export function EstimatesTab({
  task,
  projectId,
  estimationMode,
  userIsScheduler,
  sprintIsActive = false,
}: EstimatesTabProps) {
  const updateTask = useUpdateTask();
  const approveEstimates = useApproveEstimates(projectId);

  // Local controlled state mirrors task props; resets when task changes
  const [optimistic, setOptimistic] = useState<string>(
    task.optimisticDuration != null ? String(task.optimisticDuration) : '',
  );
  const [mostLikely, setMostLikely] = useState<string>(
    task.mostLikelyDuration != null ? String(task.mostLikelyDuration) : '',
  );
  const [pessimistic, setPessimistic] = useState<string>(
    task.pessimisticDuration != null ? String(task.pessimisticDuration) : '',
  );
  const [remaining, setRemaining] = useState<string>(
    task.remainingPoints != null ? String(task.remainingPoints) : '',
  );

  useEffect(() => {
    setOptimistic(task.optimisticDuration != null ? String(task.optimisticDuration) : '');
    setMostLikely(task.mostLikelyDuration != null ? String(task.mostLikelyDuration) : '');
    setPessimistic(task.pessimisticDuration != null ? String(task.pessimisticDuration) : '');
    setRemaining(task.remainingPoints != null ? String(task.remainingPoints) : '');
  }, [task.id, task.optimisticDuration, task.mostLikelyDuration, task.pessimisticDuration, task.remainingPoints]);

  // Save on blur using the current input value
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleUpdate(patch: {
    optimistic_duration?: number | null;
    most_likely_duration?: number | null;
    pessimistic_duration?: number | null;
  }) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      updateTask.mutate({ id: task.id, projectId, ...patch });
    }, 300);
  }

  function handleOptimisticBlur(value: string) {
    const n = value === '' ? null : Number(value);
    scheduleUpdate({ optimistic_duration: n });
  }
  function handleMostLikelyBlur(value: string) {
    const n = value === '' ? null : Number(value);
    scheduleUpdate({ most_likely_duration: n });
  }
  function handlePessimisticBlur(value: string) {
    const n = value === '' ? null : Number(value);
    scheduleUpdate({ pessimistic_duration: n });
  }

  const isReadonly =
    estimationMode === 'pm_only' && !userIsScheduler;

  const o = task.optimisticDuration;
  const m = task.mostLikelyDuration;
  const p = task.pessimisticDuration;
  const allThreeSet = o != null && m != null && p != null;
  const pertExpected = allThreeSet ? (o + 4 * m + p) / 6 : null;
  const pertStdDev = allThreeSet ? (p - o) / 6 : null;

  // In suggest_approve, accepted estimates are shown in the PERT panel.
  // Pending estimates show the pending banner instead.
  const showPertPanel =
    allThreeSet &&
    (estimationMode !== 'suggest_approve' || task.estimateStatus === 'accepted');

  const showPendingBanner =
    estimationMode === 'suggest_approve' && task.estimateStatus === 'pending';

  return (
    <div className="flex flex-col gap-4">
      {/* Pending approval banner — suggest_approve mode */}
      {showPendingBanner && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-brand-accent/40 bg-brand-accent-light/40 px-3 py-2.5"
        >
          <span className="text-brand-accent-dark text-lg leading-none mt-0.5" aria-hidden="true">
            ⏳
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-brand-accent-dark">
              Pending approval
            </p>
            <p className="text-xs text-brand-accent-dark/80 mt-0.5">
              These estimates are awaiting scheduler review before being used in Monte Carlo.
            </p>
          </div>
          {userIsScheduler && (
            <button
              type="button"
              onClick={() => approveEstimates.mutate(task.id)}
              disabled={approveEstimates.isPending}
              className="shrink-0 h-8 px-3 rounded text-xs font-semibold border border-brand-accent-dark/40
                text-brand-accent-dark bg-brand-accent-light hover:bg-brand-accent/20
                disabled:opacity-50 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {approveEstimates.isPending ? 'Accepting…' : 'Accept'}
            </button>
          )}
        </div>
      )}

      {/* pm_only read-only notice for non-schedulers */}
      {estimationMode === 'pm_only' && !userIsScheduler && (
        <p className="text-xs text-neutral-text-secondary">
          Estimates are managed by the project scheduler in this project.
        </p>
      )}

      {/* Three-point estimate inputs */}
      <fieldset className="flex flex-col gap-3">
        <legend className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-1">
          Three-Point Estimates (working days)
        </legend>

        <EstimateField
          label="Optimistic (O)"
          value={optimistic}
          onChange={setOptimistic}
          onBlur={handleOptimisticBlur}
          disabled={isReadonly}
          id={`opt-${task.id}`}
        />
        <EstimateField
          label="Most Likely (M)"
          value={mostLikely}
          onChange={setMostLikely}
          onBlur={handleMostLikelyBlur}
          disabled={isReadonly}
          id={`ml-${task.id}`}
        />
        <EstimateField
          label="Pessimistic (P)"
          value={pessimistic}
          onChange={setPessimistic}
          onBlur={handlePessimisticBlur}
          disabled={isReadonly}
          id={`pes-${task.id}`}
        />
      </fieldset>

      {/* PERT summary panel */}
      {showPertPanel && pertExpected != null && pertStdDev != null && (
        <div
          className="rounded-lg border border-neutral-border bg-neutral-surface-raised px-4 py-3 flex gap-6"
          role="region"
          aria-label="PERT calculation"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-neutral-text-secondary">Expected (E)</span>
            <span className="text-sm font-semibold text-neutral-text-primary tabular-nums">
              {pertExpected.toFixed(1)} days
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-neutral-text-secondary">Std Dev (σ)</span>
            <span className="text-sm font-semibold text-neutral-text-primary tabular-nums">
              ±{pertStdDev.toFixed(1)} days
            </span>
          </div>
        </div>
      )}

      {/* Incomplete hint */}
      {!allThreeSet && (
        <p className="text-xs text-neutral-text-secondary">
          Set all three values to enable PERT calculations and Monte Carlo sampling.
        </p>
      )}

      {/* suggest_approve guidance for non-schedulers */}
      {estimationMode === 'suggest_approve' && !userIsScheduler && !showPendingBanner && (
        <p className="text-xs text-neutral-text-secondary">
          Your estimates will be submitted for scheduler approval before being used in Monte Carlo.
        </p>
      )}

      {/* Sprint effort — only shown when task is in a sprint */}
      {task.sprintId && (
        <fieldset className="flex flex-col gap-3 border-t border-neutral-border pt-4">
          <legend className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-1">
            Sprint Effort
          </legend>

          {/* Story points — read-only; commitment baseline must not change mid-sprint */}
          <div className="flex items-center gap-3">
            <span className="w-36 shrink-0 text-xs text-neutral-text-secondary">
              Committed (pts)
            </span>
            <span
              className="w-24 h-9 flex items-center justify-center text-sm text-neutral-text-primary
                tppm-mono border border-neutral-border/50 rounded bg-neutral-surface-raised"
              aria-label="Committed story points (read-only)"
            >
              {task.storyPoints ?? '—'}
            </span>
          </div>

          {/* Remaining points — editable when sprint is active */}
          <EstimateField
            label="Remaining (pts)"
            value={remaining}
            onChange={setRemaining}
            onBlur={(value) => {
              const n = value === '' ? null : Number(value);
              updateTask.mutate({ id: task.id, projectId, remaining_points: n });
            }}
            disabled={!sprintIsActive || task.status === 'COMPLETE'}
            id={`rem-${task.id}`}
          />

          {task.status === 'COMPLETE' && (
            <p className="text-xs text-neutral-text-secondary">
              Remaining effort is zeroed automatically when a task is completed.
            </p>
          )}
          {!sprintIsActive && task.status !== 'COMPLETE' && (
            <p className="text-xs text-neutral-text-secondary">
              Remaining effort can be updated while the sprint is active.
            </p>
          )}
        </fieldset>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EstimateField
// ---------------------------------------------------------------------------

interface EstimateFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: (v: string) => void;
  disabled: boolean;
  id: string;
}

function EstimateField({ label, value, onChange, onBlur, disabled, id }: EstimateFieldProps) {
  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor={id}
        className="w-36 shrink-0 text-xs text-neutral-text-secondary"
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={0}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onBlur(e.target.value)}
        disabled={disabled}
        placeholder="—"
        className="w-24 h-11 md:h-9 text-sm border border-neutral-border rounded px-2 text-center
          bg-neutral-surface text-neutral-text-primary
          disabled:bg-neutral-surface-raised disabled:text-neutral-text-disabled disabled:cursor-not-allowed
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />
      <span className="text-xs text-neutral-text-disabled">days</span>
    </div>
  );
}
