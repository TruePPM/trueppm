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
import { UnsavedDot } from '@/components/dialog';

/** Parse a numeric-input string to a number, or null for empty/non-finite. */
function parseEstimate(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

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

  // #1985: in the drawer this section binds O/M/P to the drawer's deferred Save
  // draft via TaskDraftContext (staged behind the Save bar); on the full page
  // (no provider), or before the binding matches this task, it falls back to the
  // immediate blur-PATCH path below.
  // `boundBinding` is the draft binding narrowed to non-null when it is present
  // AND for this task (during a dirty swap the drawer's renderedTask leads the
  // host selection, so the id guard stops binding to the wrong task).
  const draftBinding = useTaskDraft();
  const boundBinding = draftBinding && draftBinding.taskId === task.id ? draftBinding : null;

  // Local controlled state — the immediate (unbound / full-page) path. When
  // bound, the inputs read the draft binding instead of this state.
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
  }, [
    task.id,
    task.optimisticDuration,
    task.mostLikelyDuration,
    task.pessimisticDuration,
    task.remainingPoints,
  ]);

  // Save on blur using the current input value — the UNBOUND (full-page) path.
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

  // Effective values + handlers: the draft when bound, local state otherwise.
  const noBlur = () => {};
  const optValue = boundBinding ? boundBinding.values.optimistic : optimistic;
  const mlValue = boundBinding ? boundBinding.values.mostLikely : mostLikely;
  const pesValue = boundBinding ? boundBinding.values.pessimistic : pessimistic;
  const setOpt = (v: string) =>
    boundBinding ? boundBinding.setField('optimistic', v) : setOptimistic(v);
  const setMl = (v: string) =>
    boundBinding ? boundBinding.setField('mostLikely', v) : setMostLikely(v);
  const setPes = (v: string) =>
    boundBinding ? boundBinding.setField('pessimistic', v) : setPessimistic(v);
  const optBlur = boundBinding ? noBlur : handleOptimisticBlur;
  const mlBlur = boundBinding ? noBlur : handleMostLikelyBlur;
  const pesBlur = boundBinding ? noBlur : handlePessimisticBlur;

  // Per-field unsaved markers + aggregate dirtiness (drawer only).
  const changedO = boundBinding?.changed.optimistic ?? false;
  const changedM = boundBinding?.changed.mostLikely ?? false;
  const changedP = boundBinding?.changed.pessimistic ?? false;
  const estimatesDirty = changedO || changedM || changedP;

  const isReadonly = estimationMode === 'pm_only' && !userIsScheduler;

  // PERT reads the EFFECTIVE values so the preview reflects unsaved edits live
  // when bound (#1985). An out-of-order triple (transient while mid-type)
  // suppresses σ — a negative σ is nonsense — and shows a non-blocking hint; the
  // drawer's Save bar owns the actual save-gating (would 400, #1982).
  const oN = boundBinding ? parseEstimate(optValue) : (task.optimisticDuration ?? null);
  const mN = boundBinding ? parseEstimate(mlValue) : (task.mostLikelyDuration ?? null);
  const pN = boundBinding ? parseEstimate(pesValue) : (task.pessimisticDuration ?? null);
  const allThreeSet = oN != null && mN != null && pN != null;
  const outOfOrder = allThreeSet && !(oN <= mN && mN <= pN);
  const pertExpected = allThreeSet ? (oN + 4 * mN + pN) / 6 : null;
  const pertStdDev = allThreeSet && !outOfOrder ? (pN - oN) / 6 : null;
  // Ties the three inputs to the ordering error via aria-describedby so a
  // screen-reader user in any field learns which fields are implicated (#2206).
  const orderErrorId = `est-order-${task.id}`;

  // Accepting a velocity suggestion PATCHes most_likely immediately; block it
  // while the estimate draft is dirty to avoid a draft-vs-suggestion-vs-server
  // three-way conflict. On a clean accept, re-baseline Most Likely into the draft
  // so the bound input reflects the accepted value without going spuriously dirty.
  //
  // #1999: while dirty, Accept is *accessible-disabled* (aria-disabled) rather
  // than real-`disabled`, so it stays focusable and screen readers can announce
  // why it can't be used (via the sr-only reason node). Real `disabled` is
  // reserved for the in-flight mutation case only, where clicking must be inert.
  // Because the button is still clickable while dirty, the handler must
  // early-return so a click can't fire the accept mutation.
  const velocityLocked = estimatesDirty;
  const onAcceptSuggestion = (suggestionId: string, suggested: number) => {
    if (velocityLocked) return;
    acceptSuggestion.mutate(suggestionId, {
      onSuccess: () => {
        if (boundBinding) boundBinding.commitField('mostLikely', String(suggested));
      },
    });
  };

  // In suggest_approve, accepted estimates are shown in the PERT panel; when
  // bound (drawer, mode 'open') the live draft preview always shows.
  const showPertPanel =
    allThreeSet &&
    (boundBinding != null ||
      estimationMode !== 'suggest_approve' ||
      task.estimateStatus === 'accepted');

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
            {/* #1999: Dismiss writes no estimate field, so there is no
                draft-vs-server race — it stays fully actionable while the
                estimate draft is dirty. Only an in-flight mutation disables it. */}
            <button
              type="button"
              onClick={() => dismissSuggestion.mutate(pendingSuggestion.id)}
              disabled={dismissSuggestion.isPending || acceptSuggestion.isPending}
              className="h-8 px-3 rounded-control text-xs font-medium border border-neutral-border
                text-neutral-text-secondary bg-neutral-surface hover:bg-neutral-surface-raised
                disabled:opacity-50 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {dismissSuggestion.isPending ? 'Dismissing…' : 'Dismiss'}
            </button>
            {/* #1999: while the estimate draft is dirty, Accept is
                accessible-disabled (aria-disabled) — focusable so a screen
                reader lands on it and announces the reason via the sr-only
                node — rather than real-`disabled`, which is reserved for the
                in-flight mutation case. The onClick guards the dirty case, and
                aria-disabled dims it via the [aria-disabled] Tailwind variant. */}
            <button
              type="button"
              onClick={() =>
                onAcceptSuggestion(pendingSuggestion.id, pendingSuggestion.suggested_duration!)
              }
              disabled={acceptSuggestion.isPending || dismissSuggestion.isPending}
              aria-disabled={velocityLocked || undefined}
              aria-describedby={velocityLocked ? `est-accept-blocked-${task.id}` : undefined}
              title={velocityLocked ? 'Save or discard your estimate edits first.' : undefined}
              className="h-8 px-3 rounded-control text-xs font-semibold border border-sage-600
                text-navy-900 bg-sage-500 dark:bg-sage-400 dark:text-navy-900 hover:bg-sage-600
                disabled:opacity-50 disabled:cursor-not-allowed
                aria-disabled:opacity-50 aria-disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {acceptSuggestion.isPending ? 'Accepting…' : 'Accept'}
            </button>
            <span id={`est-accept-blocked-${task.id}`} className="sr-only">
              Save or discard your estimate edits first.
            </span>
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

        <EstimateField
          label="Optimistic (O)"
          value={optValue}
          onChange={setOpt}
          onBlur={optBlur}
          disabled={isReadonly}
          changed={changedO}
          invalid={outOfOrder}
          describedById={orderErrorId}
          id={`opt-${task.id}`}
        />
        <EstimateField
          label="Most Likely (M)"
          value={mlValue}
          onChange={setMl}
          onBlur={mlBlur}
          disabled={isReadonly}
          changed={changedM}
          invalid={outOfOrder}
          describedById={orderErrorId}
          id={`ml-${task.id}`}
        />
        <EstimateField
          label="Pessimistic (P)"
          value={pesValue}
          onChange={setPes}
          onBlur={pesBlur}
          disabled={isReadonly}
          changed={changedP}
          invalid={outOfOrder}
          describedById={orderErrorId}
          id={`pes-${task.id}`}
        />
      </fieldset>

      {/* PERT summary panel — computed from the draft live when bound (#1985).
          E is always meaningful; σ is suppressed to ±— while the triple is out
          of order (a negative σ is nonsense). */}
      {showPertPanel && pertExpected != null && (
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
              {pertStdDev != null ? `±${pertStdDev.toFixed(1)} days` : '±—'}
            </span>
          </div>
        </div>
      )}

      {/* Non-blocking ordering hint (#1985/#1982) — the drawer Save bar owns the
          hard gate; here we just tell the user what's wrong while they type. */}
      {outOfOrder && (
        <p id={orderErrorId} role="alert" className="text-xs text-semantic-at-risk">
          Estimates must satisfy Optimistic ≤ Most Likely ≤ Pessimistic.
        </p>
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
  /** Staged-but-unsaved — renders the per-field "•" marker (#1985). */
  changed?: boolean;
  /** Marks the field aria-invalid and links it to the ordering error (#2206). */
  invalid?: boolean;
  /** Id of the error node describing why the field is invalid (#2206). */
  describedById?: string;
}

function EstimateField({
  label,
  value,
  onChange,
  onBlur,
  disabled,
  id,
  changed = false,
  invalid = false,
  describedById,
}: EstimateFieldProps) {
  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor={id}
        className="w-36 shrink-0 text-xs text-neutral-text-secondary inline-flex items-center gap-1"
      >
        {label}
        {changed && <UnsavedDot />}
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
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? describedById : undefined}
        placeholder="—"
        className="w-24 h-11 md:h-9 text-sm border border-neutral-border rounded-control px-2 text-center
          bg-neutral-surface text-neutral-text-primary
          disabled:bg-neutral-surface-raised disabled:text-neutral-text-disabled disabled:cursor-not-allowed
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />
      <span className="text-xs text-neutral-text-disabled">days</span>
    </div>
  );
}
