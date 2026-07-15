import { useEffect, useRef, useState } from 'react';
import type { EstimationMode, Task } from '@/types';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useApproveEstimates } from '@/hooks/useApproveEstimates';
import {
  useAcceptVelocitySuggestion,
  useDismissVelocitySuggestion,
  useVelocitySuggestions,
} from '@/hooks/useVelocitySuggestions';
import { useTaskDraft } from './TaskDraftContext';

interface EstimatesTabProps {
  task: Task;
  projectId: string;
  estimationMode: EstimationMode;
  userIsScheduler: boolean;
  /** PM/Admin (role ≥ 3); gates velocity-suggestion accept/dismiss buttons. */
  userIsAdmin?: boolean;
  /** Whether the task's sprint is currently ACTIVE — gates remaining-points edit. */
  sprintIsActive?: boolean;
}

export function EstimatesTab({
  task,
  projectId,
  estimationMode,
  userIsScheduler,
  userIsAdmin = false,
  sprintIsActive = false,
}: EstimatesTabProps) {
  const itl = useIterationLabel(projectId);
  const updateTask = useUpdateTask();
  const approveEstimates = useApproveEstimates(projectId);

  // ADR-0065: Velocity-calibration suggestions surface only to PM-role users.
  // The list endpoint is gated server-side (membership) and the accept/dismiss
  // endpoints reject non-admin callers, but skipping the fetch entirely keeps
  // the drawer payload minimal for Viewers/Members/Schedulers.
  const { data: suggestions } = useVelocitySuggestions(userIsAdmin ? task.id : undefined);
  const acceptSuggestion = useAcceptVelocitySuggestion(task.id, projectId);
  const dismissSuggestion = useDismissVelocitySuggestion(task.id);
  // Sprint close generates at most one suggestion per task per sprint, so the
  // surface need only present the most recent pending row.
  const pendingSuggestion = suggestions?.[0];

  // #1985 / ADR-0440: inside the task-detail drawer a TaskDraftContext lets the
  // three-point estimate stage into the drawer's Save/Cancel draft (batched into
  // one PATCH on Save) instead of committing on blur. Absent — the full-page
  // TaskDetailPage, which has no Save bar — we keep the immediate 300 ms-debounced
  // single-field PATCH. The taskId guard ignores a draft seeded for a different
  // task during a canvas swap.
  const taskDraft = useTaskDraft();
  const draftActive = taskDraft != null && taskDraft.taskId === task.id;

  // Local controlled state — the immediate (fallback) O/M/P path plus the sprint
  // remaining-points field, which always mutates immediately. Resets when the task
  // changes. In draft mode the O/M/P inputs read from the draft instead (below).
  const [optimistic, setOptimistic] = useState<string>(numToStr(task.optimisticDuration));
  const [mostLikely, setMostLikely] = useState<string>(numToStr(task.mostLikelyDuration));
  const [pessimistic, setPessimistic] = useState<string>(numToStr(task.pessimisticDuration));
  const [remaining, setRemaining] = useState<string>(numToStr(task.remainingPoints));

  useEffect(() => {
    setOptimistic(numToStr(task.optimisticDuration));
    setMostLikely(numToStr(task.mostLikelyDuration));
    setPessimistic(numToStr(task.pessimisticDuration));
    setRemaining(numToStr(task.remainingPoints));
  }, [
    task.id,
    task.optimisticDuration,
    task.mostLikelyDuration,
    task.pessimisticDuration,
    task.remainingPoints,
  ]);

  // Immediate (fallback) path: debounce a single-field PATCH on blur.
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

  const isReadonly = estimationMode === 'pm_only' && !userIsScheduler;

  // Per-field descriptors that switch between the drawer draft and the immediate
  // fallback: value, change handler, blur handler, and the unsaved • marker.
  const estimateFields = [
    {
      key: 'optimistic_duration',
      label: 'Optimistic (O)',
      idPrefix: 'opt',
      local: optimistic,
      setLocal: setOptimistic,
    },
    {
      key: 'most_likely_duration',
      label: 'Most Likely (M)',
      idPrefix: 'ml',
      local: mostLikely,
      setLocal: setMostLikely,
    },
    {
      key: 'pessimistic_duration',
      label: 'Pessimistic (P)',
      idPrefix: 'pes',
      local: pessimistic,
      setLocal: setPessimistic,
    },
  ] as const;

  // Effective O/M/P for the PERT preview: the live draft values in the drawer so
  // the preview tracks what the user is typing (fixing the prior read of the
  // last-saved task.* value), or the saved task values on the immediate path.
  const o = draftActive ? taskDraft.estimates.optimistic_duration : task.optimisticDuration;
  const m = draftActive ? taskDraft.estimates.most_likely_duration : task.mostLikelyDuration;
  const p = draftActive ? taskDraft.estimates.pessimistic_duration : task.pessimisticDuration;
  const allThreeSet = o != null && m != null && p != null;
  const pertExpected = allThreeSet ? (o + 4 * m + p) / 6 : null;
  // Clamp σ at 0: the preview now reads the live draft, so a mid-edit p < o would
  // otherwise flash a negative std-dev before the user finishes typing.
  const pertStdDev = allThreeSet ? Math.max(0, (p - o) / 6) : null;

  // Accept/Dismiss of a velocity suggestion writes most_likely_duration
  // server-side (ADR-0065); disable it while an estimate edit is staged so the two
  // ways of setting the estimate can't race and clobber each other.
  const estimatesDirty =
    draftActive &&
    (taskDraft.changed.optimistic_duration ||
      taskDraft.changed.most_likely_duration ||
      taskDraft.changed.pessimistic_duration);
  const velocityBusy = acceptSuggestion.isPending || dismissSuggestion.isPending;

  // In suggest_approve, accepted estimates are shown in the PERT panel.
  // Pending estimates show the pending banner instead.
  const showPertPanel =
    allThreeSet && (estimationMode !== 'suggest_approve' || task.estimateStatus === 'accepted');

  const showPendingBanner =
    estimationMode === 'suggest_approve' && task.estimateStatus === 'pending';

  return (
    <div className="flex flex-col gap-4">
      {/* ADR-0065 — velocity-calibration suggestion (PM-only surface).
          suggested_duration is null when the ADR-0104 velocity gate suppresses it
          for a below-audience reader (#1099); with no value to revise to, hide the
          prompt rather than render an empty "suggests d". */}
      {pendingSuggestion && userIsAdmin && pendingSuggestion.suggested_duration != null && (
        <div
          role="status"
          aria-label="Velocity calibration suggestion"
          className="flex items-start gap-3 rounded-card border border-brand-primary/40 bg-brand-primary/5 px-3 py-2.5"
        >
          <span className="text-brand-primary text-lg leading-none mt-0.5" aria-hidden="true">
            📈
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-neutral-text-primary">
              Revise estimate from {pendingSuggestion.sprint_name}?
            </p>
            <p className="text-xs text-neutral-text-secondary mt-0.5">
              Team velocity suggests{' '}
              <span className="tppm-mono font-semibold text-neutral-text-primary">
                {pendingSuggestion.suggested_duration}d
              </span>{' '}
              for this task
              {task.mostLikelyDuration != null && (
                <>
                  {' '}
                  (currently <span className="tppm-mono">{task.mostLikelyDuration}d</span>)
                </>
              )}
              .
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Dismiss discards the suggestion and touches no estimate field, so
                it stays enabled even while an estimate edit is staged. */}
            <button
              type="button"
              onClick={() => dismissSuggestion.mutate(pendingSuggestion.id)}
              disabled={velocityBusy}
              className="h-8 px-3 rounded-control text-xs font-medium border border-neutral-border
                text-neutral-text-secondary bg-neutral-surface hover:bg-neutral-surface-raised
                disabled:opacity-50 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {dismissSuggestion.isPending ? 'Dismissing…' : 'Dismiss'}
            </button>
            {/* Accept writes most_likely_duration server-side, so it must not run
                while a manual estimate edit is staged (the two write paths would
                race). Use accessible-disabled — aria-disabled + focusable + an
                sr-only reason — so a keyboard/AT admin can reach it and hear why,
                rather than a real `disabled` that drops it from the tab order with
                a mouse-only `title`. */}
            <button
              type="button"
              aria-disabled={estimatesDirty || undefined}
              aria-describedby={estimatesDirty ? `est-accept-blocked-${task.id}` : undefined}
              onClick={() => {
                if (estimatesDirty || velocityBusy) return;
                acceptSuggestion.mutate(pendingSuggestion.id, {
                  // Accept wrote most_likely_duration server-side. If the drawer
                  // draft is open, re-baseline its estimate slice to the accepted
                  // value so a later Save can't re-PATCH the stale baseline over
                  // it. Safe to spread the current estimates: Accept is blocked
                  // while any estimate field is dirty, so draft === baseline here.
                  onSuccess: () => {
                    if (draftActive) {
                      taskDraft.commitEstimatesFromServer({
                        ...taskDraft.estimates,
                        most_likely_duration: pendingSuggestion.suggested_duration ?? null,
                      });
                    }
                  },
                });
              }}
              disabled={velocityBusy}
              className="h-8 px-3 rounded-control text-xs font-semibold border border-sage-600
                text-navy-900 bg-sage-500 dark:bg-sage-400 dark:text-navy-900 hover:bg-sage-600
                disabled:opacity-50 disabled:cursor-not-allowed
                aria-disabled:opacity-50 aria-disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {acceptSuggestion.isPending ? 'Accepting…' : 'Accept'}
            </button>
            {estimatesDirty && (
              <span id={`est-accept-blocked-${task.id}`} className="sr-only">
                Save or cancel your estimate changes first
              </span>
            )}
          </div>
        </div>
      )}

      {/* Pending approval banner — suggest_approve mode */}
      {showPendingBanner && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-card border border-brand-accent/40 bg-brand-accent-light/40 px-3 py-2.5"
        >
          <span className="text-brand-accent-dark text-lg leading-none mt-0.5" aria-hidden="true">
            ⏳
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-brand-accent-dark">Pending approval</p>
            <p className="text-xs text-brand-accent-dark/80 mt-0.5">
              These estimates are awaiting scheduler review before being used in Monte Carlo.
            </p>
          </div>
          {userIsScheduler && (
            <button
              type="button"
              onClick={() => approveEstimates.mutate(task.id)}
              disabled={approveEstimates.isPending}
              className="shrink-0 h-8 px-3 rounded-control text-xs font-semibold border border-brand-accent-dark/40
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

        {estimateFields.map(({ key, label, idPrefix, local, setLocal }) => (
          <EstimateField
            key={key}
            label={label}
            // Draft mode reads the staged value; fallback reads local input state.
            value={draftActive ? numToStr(taskDraft.estimates[key]) : local}
            onChange={(v) => {
              if (draftActive) taskDraft.setEstimate(key, strToNum(v));
              else setLocal(v);
            }}
            // Draft mode stages on change — nothing to flush on blur. Fallback
            // commits the debounced single-field PATCH on blur.
            onBlur={(v) => {
              if (!draftActive) scheduleUpdate({ [key]: strToNum(v) });
            }}
            // Unsaved marker only in draft mode (the immediate path has no draft).
            changed={draftActive && taskDraft.changed[key]}
            disabled={isReadonly}
            id={`${idPrefix}-${task.id}`}
          />
        ))}
      </fieldset>

      {/* PERT summary panel */}
      {showPertPanel && pertExpected != null && pertStdDev != null && (
        <div
          className="rounded-card border border-neutral-border bg-neutral-surface-raised px-4 py-3 flex gap-6"
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
            {itl.singular} Effort
          </legend>

          {/* Story points — read-only; commitment baseline must not change mid-sprint */}
          <div className="flex items-center gap-3">
            <span className="w-36 shrink-0 text-xs text-neutral-text-secondary">
              Committed (pts)
            </span>
            <span
              className="w-24 h-9 flex items-center justify-center text-sm text-neutral-text-primary
                tppm-mono border border-neutral-border/50 rounded-control bg-neutral-surface-raised"
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
              Remaining effort can be updated while the {itl.lower} is active.
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
  /** Staged-but-unsaved marker — shown only in the drawer's deferred-Save mode. */
  changed?: boolean;
}

function EstimateField({
  label,
  value,
  onChange,
  onBlur,
  disabled,
  id,
  changed = false,
}: EstimateFieldProps) {
  return (
    <div className="flex items-center gap-3">
      <label htmlFor={id} className="w-36 shrink-0 text-xs text-neutral-text-secondary">
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
        className="w-24 h-11 md:h-9 text-sm border border-neutral-border rounded-control px-2 text-center
          bg-neutral-surface text-neutral-text-primary
          disabled:bg-neutral-surface-raised disabled:text-neutral-text-disabled disabled:cursor-not-allowed
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />
      <span className="text-xs text-neutral-text-disabled">days</span>
      {/* Unsaved marker — decorative; the drawer's sr-only status region carries
          the accessible "unsaved changes in Estimates" announcement (matches the
          name field's • in TaskDetailDrawer). */}
      {changed && (
        <span
          aria-hidden="true"
          title="Unsaved"
          className="shrink-0 text-lg leading-none text-brand-primary"
        >
          •
        </span>
      )}
    </div>
  );
}

/** Number → input string, empty for null/undefined. */
function numToStr(value: number | null | undefined): string {
  return value != null ? String(value) : '';
}

/** Input string → number, null for empty. `Number('')` is 0, so guard empty first. */
function strToNum(value: string): number | null {
  return value === '' ? null : Number(value);
}
