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
import { Button } from '@/components/Button';

/** Parse a numeric-input string to a number, or null for empty/non-finite. */
function parseEstimate(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Render a nullable numeric estimate as its text-input value ("" when null). */
function numToInput(n: number | null | undefined): string {
  return n != null ? String(n) : '';
}

type TaskDraftBinding = NonNullable<ReturnType<typeof useTaskDraft>>;
type VelocitySuggestion = NonNullable<ReturnType<typeof useVelocitySuggestions>['data']>[number];
type UpdateTaskMutation = ReturnType<typeof useUpdateTask>;
type AcceptSuggestionMutation = ReturnType<typeof useAcceptVelocitySuggestion>;
type DismissSuggestionMutation = ReturnType<typeof useDismissVelocitySuggestion>;
type ApproveEstimatesMutation = ReturnType<typeof useApproveEstimates>;

interface EstimateInputs {
  optValue: string;
  mlValue: string;
  pesValue: string;
  setOpt: (v: string) => void;
  setMl: (v: string) => void;
  setPes: (v: string) => void;
  optBlur: (v: string) => void;
  mlBlur: (v: string) => void;
  pesBlur: (v: string) => void;
  changedO: boolean;
  changedM: boolean;
  changedP: boolean;
}

/**
 * Resolve the effective O/M/P input values, setters, and blur handlers: the
 * drawer's deferred-Save draft binding when present, or the immediate
 * blur-PATCH local-state path otherwise (#1985).
 */
function resolveEstimateInputs(
  boundBinding: TaskDraftBinding | null,
  local: { optimistic: string; mostLikely: string; pessimistic: string },
  setLocal: {
    setOptimistic: (v: string) => void;
    setMostLikely: (v: string) => void;
    setPessimistic: (v: string) => void;
  },
  blur: {
    handleOptimisticBlur: (v: string) => void;
    handleMostLikelyBlur: (v: string) => void;
    handlePessimisticBlur: (v: string) => void;
  },
): EstimateInputs {
  if (boundBinding) {
    return {
      optValue: boundBinding.values.optimistic,
      mlValue: boundBinding.values.mostLikely,
      pesValue: boundBinding.values.pessimistic,
      setOpt: (v) => boundBinding.setField('optimistic', v),
      setMl: (v) => boundBinding.setField('mostLikely', v),
      setPes: (v) => boundBinding.setField('pessimistic', v),
      optBlur: () => {},
      mlBlur: () => {},
      pesBlur: () => {},
      changedO: boundBinding.changed.optimistic,
      changedM: boundBinding.changed.mostLikely,
      changedP: boundBinding.changed.pessimistic,
    };
  }
  return {
    optValue: local.optimistic,
    mlValue: local.mostLikely,
    pesValue: local.pessimistic,
    setOpt: setLocal.setOptimistic,
    setMl: setLocal.setMostLikely,
    setPes: setLocal.setPessimistic,
    optBlur: blur.handleOptimisticBlur,
    mlBlur: blur.handleMostLikelyBlur,
    pesBlur: blur.handlePessimisticBlur,
    changedO: false,
    changedM: false,
    changedP: false,
  };
}

interface PertPreview {
  allThreeSet: boolean;
  outOfOrder: boolean;
  pertExpected: number | null;
  pertStdDev: number | null;
}

/**
 * PERT E/σ from the EFFECTIVE triple (draft when bound, else the saved task
 * values). An out-of-order triple (transient while mid-type) suppresses σ — a
 * negative σ is nonsense — while E stays meaningful.
 */
function derivePertPreview(
  boundBinding: TaskDraftBinding | null,
  values: { optValue: string; mlValue: string; pesValue: string },
  task: Task,
): PertPreview {
  const oN = boundBinding ? parseEstimate(values.optValue) : (task.optimisticDuration ?? null);
  const mN = boundBinding ? parseEstimate(values.mlValue) : (task.mostLikelyDuration ?? null);
  const pN = boundBinding ? parseEstimate(values.pesValue) : (task.pessimisticDuration ?? null);
  const allThreeSet = oN != null && mN != null && pN != null;
  const outOfOrder = allThreeSet && !(oN <= mN && mN <= pN);
  return {
    allThreeSet,
    outOfOrder,
    pertExpected: allThreeSet ? (oN + 4 * mN + pN) / 6 : null,
    pertStdDev: allThreeSet && !outOfOrder ? (pN - oN) / 6 : null,
  };
}

/**
 * ADR-0065 velocity-calibration suggestion (PM-only surface). Self-guarding:
 * renders nothing unless there's a pending suggestion with a concrete revised
 * value for a PM-role user. `suggested_duration` is null when the ADR-0104
 * velocity gate suppresses it for a below-audience reader (#1099).
 */
function VelocitySuggestionBanner({
  suggestion,
  task,
  userIsAdmin,
  velocityLocked,
  acceptSuggestion,
  dismissSuggestion,
  boundBinding,
}: {
  suggestion: VelocitySuggestion | undefined;
  task: Task;
  userIsAdmin: boolean;
  velocityLocked: boolean;
  acceptSuggestion: AcceptSuggestionMutation;
  dismissSuggestion: DismissSuggestionMutation;
  boundBinding: TaskDraftBinding | null;
}) {
  if (!suggestion || !userIsAdmin || suggestion.suggested_duration == null) return null;

  // Accepting a velocity suggestion PATCHes most_likely immediately; block it
  // while the estimate draft is dirty to avoid a draft-vs-suggestion-vs-server
  // three-way conflict. On a clean accept, re-baseline Most Likely into the draft
  // so the bound input reflects the accepted value without going spuriously dirty.
  //
  // #1999: while dirty, Accept is *accessible-disabled* (aria-disabled) rather
  // than real-`disabled`, so it stays focusable and screen readers can announce
  // why it can't be used. Because the button is still clickable while dirty, the
  // handler must early-return so a click can't fire the accept mutation.
  const onAccept = () => {
    if (velocityLocked) return;
    acceptSuggestion.mutate(suggestion.id, {
      onSuccess: () => {
        if (boundBinding) boundBinding.commitField('mostLikely', String(suggestion.suggested_duration));
      },
    });
  };

  return (
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
          Revise estimate from {suggestion.sprint_name}?
        </p>
        <p className="text-xs text-neutral-text-secondary mt-0.5">
          Team velocity suggests{' '}
          <span className="tppm-mono font-semibold text-neutral-text-primary">
            {suggestion.suggested_duration}d
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
          onClick={() => dismissSuggestion.mutate(suggestion.id)}
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
        <Button
          variant="primary"
          onClick={onAccept}
          disabled={acceptSuggestion.isPending || dismissSuggestion.isPending}
          aria-disabled={velocityLocked || undefined}
          aria-describedby={velocityLocked ? `est-accept-blocked-${task.id}` : undefined}
          title={velocityLocked ? 'Save or discard your estimate edits first.' : undefined}
          className="font-semibold aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
        >
          {acceptSuggestion.isPending ? 'Accepting…' : 'Accept'}
        </Button>
        <span id={`est-accept-blocked-${task.id}`} className="sr-only">
          Save or discard your estimate edits first.
        </span>
      </div>
    </div>
  );
}

/** Pending-approval banner — suggest_approve mode, pending status. Self-guarding. */
function EstimatePendingApprovalBanner({
  visible,
  task,
  userIsScheduler,
  approveEstimates,
}: {
  visible: boolean;
  task: Task;
  userIsScheduler: boolean;
  approveEstimates: ApproveEstimatesMutation;
}) {
  if (!visible) return null;
  // The brand-accent tint composited to 2.55:1 for the text-xs line and
  // failed in dark mode; use the semantic at-risk status-card recipe
  // (rule 8b/145) — its tokens are mode-aware CSS vars, so text clears AA
  // in both modes and the -bg tint no longer flashes light on dark (#2197).
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-card border border-semantic-at-risk/40 bg-semantic-at-risk-bg px-3 py-2.5"
    >
      <span className="text-semantic-at-risk text-lg leading-none mt-0.5" aria-hidden="true">
        ⏳
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-semantic-at-risk">Pending approval</p>
        <p className="text-xs text-semantic-at-risk mt-0.5">
          These estimates are awaiting scheduler review before being used in Monte Carlo.
        </p>
      </div>
      {userIsScheduler && (
        <button
          type="button"
          onClick={() => approveEstimates.mutate(task.id)}
          disabled={approveEstimates.isPending}
          className="shrink-0 h-8 px-3 rounded-control text-xs font-semibold border border-semantic-at-risk/50
                text-semantic-at-risk bg-transparent hover:bg-semantic-at-risk/10
                disabled:opacity-50 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {approveEstimates.isPending ? 'Accepting…' : 'Accept'}
        </button>
      )}
    </div>
  );
}

/**
 * PERT summary panel — computed from the draft live when bound (#1985). E is
 * always meaningful; σ is suppressed to ±— while the triple is out of order (a
 * negative σ is nonsense). Self-guarding on E being present.
 */
function PertPanel({ pert }: { pert: PertPreview }) {
  const { pertExpected, pertStdDev } = pert;
  if (pertExpected == null) return null;
  return (
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
  );
}

/** Sprint effort fieldset — committed points (read-only) + editable remaining. Self-guarding. */
function SprintEffortFieldset({
  task,
  projectId,
  sprintIsActive,
  remaining,
  setRemaining,
  updateTask,
  itl,
}: {
  task: Task;
  projectId: string;
  sprintIsActive: boolean;
  remaining: string;
  setRemaining: (v: string) => void;
  updateTask: UpdateTaskMutation;
  itl: ReturnType<typeof useIterationLabel>;
}) {
  if (!task.sprintId) return null;
  return (
    <fieldset className="flex flex-col gap-3 border-t border-neutral-border pt-4">
      <legend className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-1">
        {itl.singular} Effort
      </legend>

      {/* Story points — read-only; commitment baseline must not change mid-sprint */}
      <div className="flex items-center gap-3">
        <span className="w-36 shrink-0 text-xs text-neutral-text-secondary">Committed (pts)</span>
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
  );
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
  const [optimistic, setOptimistic] = useState<string>(numToInput(task.optimisticDuration));
  const [mostLikely, setMostLikely] = useState<string>(numToInput(task.mostLikelyDuration));
  const [pessimistic, setPessimistic] = useState<string>(numToInput(task.pessimisticDuration));
  const [remaining, setRemaining] = useState<string>(numToInput(task.remainingPoints));

  useEffect(() => {
    setOptimistic(numToInput(task.optimisticDuration));
    setMostLikely(numToInput(task.mostLikelyDuration));
    setPessimistic(numToInput(task.pessimisticDuration));
    setRemaining(numToInput(task.remainingPoints));
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
  const inputs = resolveEstimateInputs(
    boundBinding,
    { optimistic, mostLikely, pessimistic },
    { setOptimistic, setMostLikely, setPessimistic },
    { handleOptimisticBlur, handleMostLikelyBlur, handlePessimisticBlur },
  );
  const { optValue, mlValue, pesValue, setOpt, setMl, setPes, optBlur, mlBlur, pesBlur } = inputs;
  const { changedO, changedM, changedP } = inputs;

  // Aggregate dirtiness (drawer only) gates the velocity Accept (#1999).
  const estimatesDirty = changedO || changedM || changedP;
  const velocityLocked = estimatesDirty;

  // Prefer the server's own verdict (ADR-0743, #2596) so this control and the
  // serializer guard read one rule. The mode/role derivation stays as the fallback
  // for rows that predate the field (WebSocket deltas, optimistic local creates).
  // It is no longer the enforcement — that is now server-side; this is the affordance.
  const isReadonly =
    task.canEditEstimates !== undefined
      ? !task.canEditEstimates
      : estimationMode === 'pm_only' && !userIsScheduler;

  // PERT reads the EFFECTIVE values so the preview reflects unsaved edits live
  // when bound (#1985). The Save bar owns the hard save-gating (would 400, #1982).
  const pert = derivePertPreview(boundBinding, { optValue, mlValue, pesValue }, task);
  const { allThreeSet, outOfOrder } = pert;
  // Ties the three inputs to the ordering error via aria-describedby so a
  // screen-reader user in any field learns which fields are implicated (#2206).
  const orderErrorId = `est-order-${task.id}`;

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
      <VelocitySuggestionBanner
        suggestion={pendingSuggestion}
        task={task}
        userIsAdmin={userIsAdmin}
        velocityLocked={velocityLocked}
        acceptSuggestion={acceptSuggestion}
        dismissSuggestion={dismissSuggestion}
        boundBinding={boundBinding}
      />

      <EstimatePendingApprovalBanner
        visible={showPendingBanner}
        task={task}
        userIsScheduler={userIsScheduler}
        approveEstimates={approveEstimates}
      />

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

      {showPertPanel && <PertPanel pert={pert} />}

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

      <SprintEffortFieldset
        task={task}
        projectId={projectId}
        sprintIsActive={sprintIsActive}
        remaining={remaining}
        setRemaining={setRemaining}
        updateTask={updateTask}
        itl={itl}
      />
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
