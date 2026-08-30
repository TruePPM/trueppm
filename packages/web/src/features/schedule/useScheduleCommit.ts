import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useRescheduleTask } from '@/hooks/useTaskMutations';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { useScheduleStore } from '@/stores/scheduleStore';
import type { GanttEngine } from './engine';
import { dateToLeft, leftToDate } from './engine';
import { CHART_HEADER_HEIGHT, ROW_HEIGHT } from './scheduleConstants';
import type { Task, ApiSprint } from '@/types';
import type { CommitAction } from './ScheduleCommitPopover';

/**
 * Orchestrates the pull-to-commit gate on Schedule canvas drag and resize (ADR-0067).
 *
 * Subscribes to `drag-task-end` and `resize-task-end` from the engine. On a
 * non-cancelled release:
 *   1. Compute the proposed change.
 *   2. Bail when there is no net change.
 *   3. Move the bar visually via `engine.updateTask` so the user sees where
 *      the change will land — the React Query cache stays untouched until Confirm.
 *   4. Snapshot the original date/duration so Cancel can revert.
 *   5. Expose state for the host to render `<ScheduleCommitPopover>`.
 *
 * Confirm fires `useRescheduleTask.mutate(...)` which applies its own
 * optimistic cache update (and the bar's visual position already matches).
 * Cancel reverts the engine to the original task state with no PATCH.
 *
 * Click-outside cancels and surfaces a toast via `setScheduleActionToast`.
 *
 * Esc inside the popover is handled by the popover component itself with a
 * window-level capture handler so it takes priority over hover-chain Esc
 * (ADR-0066) and build-mode focus rollback (ADR-0054).
 */

export interface ScheduleCommitState {
  taskId: string;
  task: Task;
  action: CommitAction;
  /** Original state snapshot — used by Cancel to revert the engine bar. */
  originalStart: string;
  originalFinish: string;
  originalDuration: number;
  /** New computed state — applied to the engine for visual preview. */
  newStart: string;
  newFinish: string;
  newDuration: number;
  /** Viewport coordinates for the popover anchor (center-x, top-y of bar). */
  anchor: { x: number; y: number };
  /** Inline error from a failed mutation, or null. */
  error: string | null;
  /** ACTIVE sprint name when the task is committed to one, else null. */
  activeSprintName: string | null;
}

/**
 * Project-start floor prompt state (#868). Set when a reschedule confirm lands
 * before the project start date instead of firing the PATCH; cleared when the
 * user snaps, moves the project start, or cancels.
 */
export interface BeforeStartPromptState {
  taskId: string;
  /** The before-start date the user dragged/typed to (ISO). */
  attemptedStart: string;
  /** Task duration in days — used to recompute finish on snap/move. */
  duration: number;
  /** The literal project start date (ISO) — shown in the prompt header. */
  projectStartDate: string;
  /** The effective floor (first working day, ISO) — the snap target (#884). */
  effectiveFloorDate: string;
  /** Original bar position so Cancel can revert the engine preview. */
  revert: { start: string; finish: string; duration: number };
  /** Inline error from a failed snap/move mutation, or null. */
  error: string | null;
}

export interface UseScheduleCommitOptions {
  engine: GanttEngine | null;
  projectId: string | null;
  /** Project start date (ISO `YYYY-MM-DD`) — shown literally in the prompt header. */
  projectStartDate: string | null;
  /**
   * Effective schedule floor (ISO) — first working day on or after the project
   * start (#884). The before-start check and snap target use THIS, not the
   * literal start, so a weekend start floors to the next working day. Falls back
   * to `projectStartDate` when absent.
   */
  effectiveFloorDate?: string | null;
  /**
   * The project's effective working-day bitmask (`effective_calendar.working_days`,
   * ADR-0441 / #1987). Defaults to Mon–Fri when absent (older payloads / the list
   * cache), matching the server's own `working_day_duration` fallback. Drives the
   * resize popover's duration label and the no-op-resize guard (#2561).
   */
  workingDaysMask?: number | null;
  visibleTasks: Task[];
  allTasks: Task[];
  sprints: ApiSprint[];
  canvasContainerRef: RefObject<HTMLDivElement | null>;
  ariaAssertiveRef: RefObject<HTMLDivElement | null>;
}

export interface UseScheduleCommitApi {
  state: ScheduleCommitState | null;
  isPending: boolean;
  /**
   * Commit a KEYBOARD reschedule (#3141) — `r`, arrows, Enter.
   *
   * The pointer path answers `drag-task-end` by opening the ADR-0067 popover,
   * and Enter has already served as that confirmation, so the keyboard path
   * must not open a second one. What it must NOT do is what it used to: set the
   * drag store to `'committing'`, announce "Reschedule confirmed." and issue no
   * PATCH at all. Same floor guard and same payload as the popover's confirm —
   * only the confirmation gesture differs.
   *
   * Announces its own outcome, because the caller cannot know one: the mutation
   * is async and the old code's unconditional announcement is the defect.
   */
  commitKeyboardReschedule: (taskId: string, newStartIso: string) => void;
  handleConfirm: () => void;
  handleCancel: () => void;
  handleDismissByOutsideClick: () => void;
  /** Project-start floor prompt (#868), or null when not blocked. */
  beforeStartPrompt: BeforeStartPromptState | null;
  /** True while a snap or move-project-start mutation is in flight. */
  beforeStartPending: boolean;
  /** Re-pin the blocked task to the project start date and persist. */
  handleSnapToProjectStart: () => void;
  /** Move the project start to the attempted date (Admin/Owner), then persist. */
  handleMoveProjectStart: () => void;
  /** Revert the engine preview and dismiss the floor prompt. */
  handleCancelBeforeStart: () => void;
}

/** Best-effort human message from a DRF error payload (detail, then first field). */
function extractErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const detail = (data as { detail?: unknown }).detail;
    if (typeof detail === 'string') return detail;
    const firstVal = Object.values(data as Record<string, unknown>)[0];
    if (Array.isArray(firstVal) && typeof firstVal[0] === 'string') return firstVal[0];
    if (typeof firstVal === 'string') return firstVal;
  }
  return fallback;
}

const DAY_MS = 86_400_000;

function isoFromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Mon–Fri (1+2+4+8+16) — mirrors the server's `working_day_duration` default. */
const MON_FRI_MASK = 31;

/**
 * Is a UTC-midnight instant a working day under a `Calendar.working_days` mask?
 *
 * The mask convention is `bit = 1 << pythonWeekday` (Mon=1 … Sun=64), identical
 * to the server's. Deliberately NOT reusing `bitForDate` from `lib/recurrence.ts`:
 * that helper reads `getDay()` (viewer-local), and every date in this module is a
 * UTC-midnight instant (rule 56). A local read shifts the weekday by one for any
 * viewer behind UTC, which would silently mis-classify Friday as Saturday — a
 * class of bug that passes CI, because the runner sits on UTC.
 */
function isWorkingDayUtc(ms: number, mask: number): boolean {
  const dow = new Date(ms).getUTCDay(); // 0 = Sun … 6 = Sat
  const bit = 1 << (dow === 0 ? 6 : dow - 1); // Mon=1 … Sat=32, Sun=64
  return (mask & bit) !== 0;
}

/**
 * Working days in `[startIso, finishIso]` inclusive under the project calendar's
 * weekday mask — a client-side estimate of the duration the server computes from
 * `planned_finish` (#951).
 *
 * The server stays authoritative on commit; this is used to label the commit
 * popover and to detect a resize that resolves to no duration change at all
 * (#2561 — dropping the handle on a non-working day counts zero extra working
 * days, so the drag cannot move `duration`).
 *
 * Blind to holidays: the calendar payload carries `holiday_count`, not the
 * exception dates, so a holiday the weekly mask treats as working is counted
 * here and excluded by the server. The no-op guard compares two counts taken
 * with this same function, so a holiday inside the unchanged prefix cancels out;
 * the residue is a holiday landing in the extended region (#1498).
 */
function workingDaysInclusive(startIso: string, finishIso: string, mask: number): number {
  const startMs = new Date(startIso + 'T00:00:00Z').getTime();
  const finishMs = new Date(finishIso + 'T00:00:00Z').getTime();
  let count = 0;
  for (let ms = startMs; ms <= finishMs; ms += DAY_MS) {
    if (isWorkingDayUtc(ms, mask)) count += 1;
  }
  return Math.max(1, count);
}

/** "Aug 15" — UTC-parsed to match this module's date arithmetic (rule 56). */
function formatDayLabel(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function computeNewFinishIso(newStartIso: string, durationDays: number): string {
  const startMs = new Date(newStartIso + 'T00:00:00Z').getTime();
  return isoFromUtcMs(startMs + durationDays * DAY_MS);
}

function computeRescheduleResize(
  newStartIso: string,
  newDuration: number,
): { newStart: string; newFinish: string; newDuration: number } {
  const newFinish = computeNewFinishIso(newStartIso, newDuration);
  return { newStart: newStartIso, newFinish, newDuration };
}

export function useScheduleCommit({
  engine,
  projectId,
  projectStartDate,
  effectiveFloorDate,
  workingDaysMask,
  visibleTasks,
  allTasks,
  sprints,
  canvasContainerRef,
  ariaAssertiveRef,
}: UseScheduleCommitOptions): UseScheduleCommitApi {
  const [state, setState] = useState<ScheduleCommitState | null>(null);
  const [beforeStartPrompt, setBeforeStartPrompt] = useState<BeforeStartPromptState | null>(null);
  const rescheduleTask = useRescheduleTask();
  const updateProject = useUpdateProject(projectId);
  const setScheduleActionToast = useScheduleStore((s) => s.setScheduleActionToast);
  const setScheduleError = useScheduleStore((s) => s.setScheduleError);

  // Stable refs to avoid stale closures in engine event listeners.
  const visibleTasksRef = useRef(visibleTasks);
  const allTasksRef = useRef(allTasks);
  const sprintsRef = useRef(sprints);
  useEffect(() => {
    visibleTasksRef.current = visibleTasks;
  }, [visibleTasks]);
  useEffect(() => {
    allTasksRef.current = allTasks;
  }, [allTasks]);
  useEffect(() => {
    sprintsRef.current = sprints;
  }, [sprints]);
  // The mask arrives with the project detail fetch, after the engine listeners are
  // subscribed — a plain closure would keep the Mon–Fri fallback forever.
  const workingDaysMaskRef = useRef(workingDaysMask ?? MON_FRI_MASK);
  useEffect(() => {
    workingDaysMaskRef.current = workingDaysMask ?? MON_FRI_MASK;
  }, [workingDaysMask]);

  const computeAnchor = useCallback(
    (taskId: string, newBarLeftCanvas: number, newBarRightCanvas: number): { x: number; y: number } | null => {
      const container = canvasContainerRef.current;
      if (!container || !engine) return null;
      const rect = container.getBoundingClientRect();
      const rowIndex = visibleTasksRef.current.findIndex((t) => t.id === taskId);
      if (rowIndex < 0) return null;
      // Canvas-origin coordinates (rule 57) — subtract container scroll, add
      // container viewport offset to get final screen-fixed coordinates.
      const barCenterCanvasX = (newBarLeftCanvas + newBarRightCanvas) / 2;
      const x = rect.left + (barCenterCanvasX - engine.scrollLeft);
      const rowTopCanvasY = CHART_HEADER_HEIGHT + rowIndex * ROW_HEIGHT;
      const y = rect.top + (rowTopCanvasY - container.scrollTop);
      return { x, y };
    },
    [engine, canvasContainerRef],
  );

  const findActiveSprintName = useCallback((task: Task): string | null => {
    if (!task.sprintId) return null;
    const sprint = sprintsRef.current.find((s) => s.id === task.sprintId);
    return sprint && sprint.state === 'ACTIVE' ? sprint.name : null;
  }, []);

  // Drag-end → open popover (or commit on no-op).
  useEffect(() => {
    if (!engine || !projectId) return;
    return engine.on('drag-task-end', ({ id, left, cancelled }) => {
      if (cancelled) return;
      const scales = engine.scales;
      if (!scales) return;
      const task = allTasksRef.current.find((t) => t.id === id);
      if (!task) return;
      const newStartIso = leftToDate(left, scales).toISOString().slice(0, 10);
      if (newStartIso === task.start) return; // No net move — skip popover.
      const proposed = computeRescheduleResize(newStartIso, task.duration);
      // Move the bar visually so the user sees where the change will land.
      engine.updateTask(id, {
        start: proposed.newStart,
        finish: proposed.newFinish,
      });
      const newBarRight = dateToLeft(proposed.newFinish, scales);
      const anchor = computeAnchor(id, left, newBarRight);
      if (!anchor) return;
      setState({
        taskId: id,
        task,
        action: {
          kind: 'reschedule',
          oldStartIso: task.start,
          newStartIso: proposed.newStart,
        },
        originalStart: task.start,
        originalFinish: task.finish,
        originalDuration: task.duration,
        newStart: proposed.newStart,
        newFinish: proposed.newFinish,
        newDuration: proposed.newDuration,
        anchor,
        error: null,
        activeSprintName: findActiveSprintName(task),
      });
      if (ariaAssertiveRef.current) {
        ariaAssertiveRef.current.textContent = 'Reschedule pending. Confirm or cancel.';
      }
    });
  }, [engine, projectId, computeAnchor, findActiveSprintName, ariaAssertiveRef]);

  // Resize-end → open popover (or commit on no-op).
  useEffect(() => {
    if (!engine || !projectId) return;
    return engine.on('resize-task-end', ({ id, right, cancelled }) => {
      if (cancelled) return;
      const scales = engine.scales;
      if (!scales) return;
      const task = allTasksRef.current.find((t) => t.id === id);
      if (!task?.start) return;
      // The resize handle tracks the bar's EXCLUSIVE right edge — `dateToRight`
      // paints one day past the inclusive finish (the morning after the last
      // working day). Snap that edge to a day boundary (the FSM emits an
      // unsnapped pixel `right`) and step back one day to recover the finish
      // DATE the user dropped on.
      const exclusiveEdgeMs = Math.round(leftToDate(right, scales).getTime() / DAY_MS) * DAY_MS;
      const newFinish = isoFromUtcMs(exclusiveEdgeMs - DAY_MS);
      // No-op / invalid guards compare the finish DATE — NOT a calendar-day vs
      // working-day duration, which falsely fired when the bar spanned a weekend
      // or holiday (#951): a no-op grab read the calendar span (e.g. 4) against
      // the stored working-day duration (e.g. 2) and proposed a phantom resize.
      if (newFinish < task.start) return;
      if (newFinish === task.finish) return;
      // Duration is derived server-side from `planned_finish` via the project
      // calendar (#951); this working-day estimate only labels the popover.
      const mask = workingDaysMaskRef.current;
      const newDuration = workingDaysInclusive(task.start, newFinish, mask);
      // #2561: the finish DATE moved but the WORKING-day span did not, because the
      // user dropped the handle on a non-working day. `planned_finish` resolves to
      // the same duration server-side, so the PATCH would be a no-op and the CPM
      // refetch would redraw the bar where it started — reading as an unexplained
      // snap-back after the user confirmed a "7d → 7d" popover. Say so instead.
      //
      // Compare two counts taken with the SAME mask, not the stored duration: a
      // holiday the client cannot see (only `holiday_count` is exposed) would make
      // a client count differ from the stored value on every task, and equality is
      // the only question here. Whether a drop on non-working time SHOULD instead
      // consume the next working day is the open semantic in #2562; this guard
      // deliberately does not decide it.
      if (newDuration === workingDaysInclusive(task.start, task.finish, mask)) {
        setScheduleActionToast({
          message: `${formatDayLabel(newFinish)} isn't a working day — this task still finishes ${formatDayLabel(task.finish)}.`,
        });
        if (ariaAssertiveRef.current) {
          ariaAssertiveRef.current.textContent = `Resize not applied. ${formatDayLabel(newFinish)} is not a working day.`;
        }
        return;
      }
      engine.updateTask(id, {
        finish: newFinish,
        duration: newDuration,
      });
      const newBarLeft = dateToLeft(task.start, scales);
      const anchor = computeAnchor(id, newBarLeft, right);
      if (!anchor) return;
      setState({
        taskId: id,
        task,
        action: {
          kind: 'resize',
          oldDurationDays: task.duration,
          newDurationDays: newDuration,
        },
        originalStart: task.start,
        originalFinish: task.finish,
        originalDuration: task.duration,
        newStart: task.start,
        newFinish,
        newDuration,
        anchor,
        error: null,
        activeSprintName: findActiveSprintName(task),
      });
      if (ariaAssertiveRef.current) {
        ariaAssertiveRef.current.textContent = 'Resize pending. Confirm or cancel.';
      }
    });
  }, [
    engine,
    projectId,
    computeAnchor,
    findActiveSprintName,
    ariaAssertiveRef,
    setScheduleActionToast,
  ]);

  const revertEngine = useCallback(
    (s: ScheduleCommitState) => {
      if (!engine) return;
      engine.updateTask(s.taskId, {
        start: s.originalStart,
        finish: s.originalFinish,
        duration: s.originalDuration,
      });
    },
    [engine],
  );

  const handleCancel = useCallback(() => {
    if (!state) return;
    revertEngine(state);
    setState(null);
    if (ariaAssertiveRef.current) {
      ariaAssertiveRef.current.textContent =
        state.action.kind === 'reschedule' ? 'Reschedule cancelled.' : 'Resize cancelled.';
    }
  }, [state, revertEngine, ariaAssertiveRef]);

  const handleDismissByOutsideClick = useCallback(() => {
    if (!state) return;
    revertEngine(state);
    const message =
      state.action.kind === 'reschedule'
        ? 'Reschedule cancelled — change not saved.'
        : 'Resize cancelled — change not saved.';
    setState(null);
    setScheduleActionToast({ message });
    if (ariaAssertiveRef.current) {
      ariaAssertiveRef.current.textContent =
        state.action.kind === 'reschedule' ? 'Reschedule cancelled.' : 'Resize cancelled.';
    }
  }, [state, revertEngine, setScheduleActionToast, ariaAssertiveRef]);

  /**
   * See `UseScheduleCommitApi.commitKeyboardReschedule` (#3141).
   *
   * Deliberately reuses the popover's floor guard and payload rather than
   * re-deriving them: the two paths reschedule the same task through the same
   * endpoint, and the bug this fixes is precisely what happens when one of them
   * grows its own half-implementation.
   */
  const commitKeyboardReschedule = useCallback(
    (taskId: string, newStartIso: string) => {
      if (!projectId) return;
      const task = allTasksRef.current.find((t) => t.id === taskId);
      if (!task) return;
      if (newStartIso === task.start) return; // No net move — nothing to persist.

      const proposed = computeRescheduleResize(newStartIso, task.duration);

      // Project-start floor (#868) — same rule as the pointer path. A keyboard
      // nudge below the floor opens the snap/move/cancel prompt instead of
      // PATCHing, so the two paths cannot disagree about what is legal.
      const floor = effectiveFloorDate ?? projectStartDate;
      if (floor && proposed.newStart < floor) {
        setBeforeStartPrompt({
          taskId,
          attemptedStart: proposed.newStart,
          duration: task.duration,
          projectStartDate: projectStartDate ?? floor,
          effectiveFloorDate: floor,
          revert: { start: task.start, finish: task.finish, duration: task.duration },
          error: null,
        });
        if (ariaAssertiveRef.current) {
          ariaAssertiveRef.current.textContent =
            'This task would start before the project start date. Choose how to resolve it.';
        }
        return;
      }

      rescheduleTask.mutate(
        {
          id: taskId,
          projectId,
          planned_start: proposed.newStart,
          optimistic: { start: proposed.newStart, finish: proposed.newFinish },
        },
        {
          onSuccess: () => {
            if (ariaAssertiveRef.current) {
              ariaAssertiveRef.current.textContent = 'Reschedule confirmed.';
            }
          },
          onError: (err) => {
            // There is no popover to hold the error, so it goes to the schedule
            // error surface and is ANNOUNCED — a keyboard user has no bar to
            // look at, and silence here is how the original defect read.
            const message = extractErrorMessage(err, "Couldn't save the change. Try again.");
            setScheduleError(message);
            if (ariaAssertiveRef.current) {
              ariaAssertiveRef.current.textContent = `Reschedule failed. ${message}`;
            }
          },
        },
      );
    },
    [
      projectId,
      projectStartDate,
      effectiveFloorDate,
      rescheduleTask,
      ariaAssertiveRef,
      setScheduleError,
    ],
  );

  const handleConfirm = useCallback(() => {
    if (!state || !projectId) return;
    // Offline guard (rule 29): skip PATCH, revert preview, surface the toast.
    if (!navigator.onLine) {
      revertEngine(state);
      setState(null);
      setScheduleError("You're offline — change not saved.");
      return;
    }
    const { taskId, newStart, newFinish, newDuration, action } = state;
    // Project-start floor (#868): a reschedule that lands before the project
    // start does not PATCH — it opens the snap/move/cancel prompt instead of
    // silently clamping. The engine bar preview stays at the attempted date.
    // ISO `YYYY-MM-DD` strings compare correctly with `<`.
    // Compare against the effective floor (first working day, #884), not the
    // literal start — a weekend start floors to the next working day, and
    // snapping to the literal weekend date would re-trip the backend guard.
    const floor = effectiveFloorDate ?? projectStartDate;
    if (action.kind === 'reschedule' && floor && newStart < floor) {
      setBeforeStartPrompt({
        taskId,
        attemptedStart: newStart,
        duration: newDuration,
        projectStartDate: projectStartDate ?? floor,
        effectiveFloorDate: floor,
        revert: {
          start: state.originalStart,
          finish: state.originalFinish,
          duration: state.originalDuration,
        },
        error: null,
      });
      setState(null);
      if (ariaAssertiveRef.current) {
        ariaAssertiveRef.current.textContent =
          'This task would start before the project start date. Choose how to resolve it.';
      }
      return;
    }
    const payload =
      action.kind === 'reschedule'
        ? {
            id: taskId,
            projectId,
            planned_start: newStart,
            optimistic: { start: newStart, finish: newFinish },
          }
        : {
            // #951: send the target finish DATE; the server derives the
            // working-day duration from the project calendar. `newDuration` is
            // the client estimate used only for the optimistic preview — the
            // CPM refetch replaces it with the server-computed value.
            id: taskId,
            projectId,
            planned_finish: newFinish,
            optimistic: { finish: newFinish, duration: newDuration },
          };
    rescheduleTask.mutate(payload, {
      onSuccess: () => {
        setState(null);
        if (ariaAssertiveRef.current) {
          ariaAssertiveRef.current.textContent =
            action.kind === 'reschedule' ? 'Reschedule confirmed.' : 'Resize confirmed.';
        }
      },
      onError: (err) => {
        // Engine already shows the new position via updateTask; on PATCH
        // failure we keep the popover open so the user can Retry or Cancel.
        // useRescheduleTask.onError rolls back the cache snapshot — the engine
        // bar position therefore needs to be left alone here (it matches the
        // user's intent, which they can retry).
        const message =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          "Couldn't save the change. Try again or cancel.";
        setState((prev) => (prev ? { ...prev, error: message } : prev));
      },
    });
  }, [
    state,
    projectId,
    projectStartDate,
    effectiveFloorDate,
    rescheduleTask,
    revertEngine,
    setScheduleError,
    ariaAssertiveRef,
  ]);

  // --- Project-start floor prompt handlers (#868) ---------------------------

  /**
   * Surface a save failure inline on the before-start prompt, if it is still open.
   *
   * The `prev ? … : prev` guard matters: the user may have dismissed the prompt
   * while the request was in flight, and resurrecting it to show an error for a
   * decision they already walked away from would be wrong.
   *
   * Hoisted to hook scope so the mutation `onError` handlers below — which sit
   * two callbacks deep inside a chained mutation — don't have to nest a state
   * updater as a fifth function level (Sonar S2004).
   */
  const failBeforeStartPrompt = useCallback((message: string) => {
    setBeforeStartPrompt((prev) => (prev ? { ...prev, error: message } : prev));
  }, []);

  const handleSnapToProjectStart = useCallback(() => {
    const p = beforeStartPrompt;
    if (!p || !projectId) return;
    if (!navigator.onLine) {
      if (engine) engine.updateTask(p.taskId, p.revert);
      setBeforeStartPrompt(null);
      setScheduleError("You're offline — change not saved.");
      return;
    }
    // Snap to the effective working-day floor (#884), not the literal start —
    // the literal weekend date would be rejected by the backend floor guard.
    const snappedStart = p.effectiveFloorDate;
    const snappedFinish = computeNewFinishIso(snappedStart, p.duration);
    // Move the preview bar from the attempted (before-start) position to the floor.
    if (engine) engine.updateTask(p.taskId, { start: snappedStart, finish: snappedFinish });
    setBeforeStartPrompt((prev) => (prev ? { ...prev, error: null } : prev));
    rescheduleTask.mutate(
      {
        id: p.taskId,
        projectId,
        planned_start: snappedStart,
        optimistic: { start: snappedStart, finish: snappedFinish },
      },
      {
        onSuccess: () => {
          setBeforeStartPrompt(null);
          if (ariaAssertiveRef.current) {
            ariaAssertiveRef.current.textContent = 'Snapped to the project start date.';
          }
        },
        onError: (err) => {
          failBeforeStartPrompt(extractErrorMessage(err, "Couldn't save the change. Try again."));
        },
      },
    );
  }, [beforeStartPrompt, projectId, engine, rescheduleTask, setScheduleError, ariaAssertiveRef, failBeforeStartPrompt]);

  const handleMoveProjectStart = useCallback(() => {
    const p = beforeStartPrompt;
    if (!p || !projectId) return;
    if (!navigator.onLine) {
      if (engine) engine.updateTask(p.taskId, p.revert);
      setBeforeStartPrompt(null);
      setScheduleError("You're offline — change not saved.");
      return;
    }
    setBeforeStartPrompt((prev) => (prev ? { ...prev, error: null } : prev));
    // Two steps: move the project start floor earlier, then persist the task.
    // The server enforces Admin+ on start_date; a non-admin surfaces inline.
    updateProject.mutate(
      { start_date: p.attemptedStart },
      {
        onSuccess: () => {
          const finish = computeNewFinishIso(p.attemptedStart, p.duration);
          rescheduleTask.mutate(
            {
              id: p.taskId,
              projectId,
              planned_start: p.attemptedStart,
              optimistic: { start: p.attemptedStart, finish },
            },
            {
              onSuccess: () => {
                setBeforeStartPrompt(null);
                if (ariaAssertiveRef.current) {
                  ariaAssertiveRef.current.textContent =
                    'Project start moved; task scheduled.';
                }
              },
              onError: (err) => {
                failBeforeStartPrompt(
                  extractErrorMessage(
                    err,
                    'Moved the project start, but saving the task failed. Try again.',
                  ),
                );
              },
            },
          );
        },
        onError: (err) => {
          failBeforeStartPrompt(
            extractErrorMessage(
              err,
              "Couldn't move the project start date. You may not have permission.",
            ),
          );
        },
      },
    );
  }, [beforeStartPrompt, projectId, engine, updateProject, rescheduleTask, setScheduleError, ariaAssertiveRef, failBeforeStartPrompt]);

  const handleCancelBeforeStart = useCallback(() => {
    const p = beforeStartPrompt;
    if (!p) return;
    if (engine) engine.updateTask(p.taskId, p.revert);
    setBeforeStartPrompt(null);
    setScheduleActionToast({ message: 'Reschedule cancelled — change not saved.' });
    if (ariaAssertiveRef.current) {
      ariaAssertiveRef.current.textContent = 'Reschedule cancelled.';
    }
  }, [beforeStartPrompt, engine, setScheduleActionToast, ariaAssertiveRef]);

  return {
    state,
    isPending: rescheduleTask.isPending,
    commitKeyboardReschedule,
    handleConfirm,
    handleCancel,
    handleDismissByOutsideClick,
    beforeStartPrompt,
    beforeStartPending: rescheduleTask.isPending || updateProject.isPending,
    handleSnapToProjectStart,
    handleMoveProjectStart,
    handleCancelBeforeStart,
  };
}
