import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useRescheduleTask } from '@/hooks/useTaskMutations';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { useScheduleStore } from '@/stores/scheduleStore';
import type { GanttEngine } from './engine';
import { dateToLeft, leftToDate } from './engine';
import { HEADER_HEIGHT, ROW_HEIGHT } from './scheduleConstants';
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
  visibleTasks: Task[];
  allTasks: Task[];
  sprints: ApiSprint[];
  canvasContainerRef: RefObject<HTMLDivElement | null>;
  ariaAssertiveRef: RefObject<HTMLDivElement | null>;
  onCommitSuccess?: () => void;
}

export interface UseScheduleCommitApi {
  state: ScheduleCommitState | null;
  isPending: boolean;
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

function isoFromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function computeNewFinishIso(newStartIso: string, durationDays: number): string {
  const startMs = new Date(newStartIso + 'T00:00:00Z').getTime();
  return isoFromUtcMs(startMs + durationDays * 86_400_000);
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
  visibleTasks,
  allTasks,
  sprints,
  canvasContainerRef,
  ariaAssertiveRef,
  onCommitSuccess,
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
      const rowTopCanvasY = HEADER_HEIGHT + rowIndex * ROW_HEIGHT;
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
      const newFinish = leftToDate(right, scales);
      const startMs = new Date(task.start + 'T00:00:00Z').getTime();
      const newDuration = Math.max(1, Math.round((newFinish.getTime() - startMs) / 86_400_000));
      if (newDuration === task.duration) return;
      const proposed = computeRescheduleResize(task.start, newDuration);
      engine.updateTask(id, {
        finish: proposed.newFinish,
        duration: proposed.newDuration,
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
        newStart: proposed.newStart,
        newFinish: proposed.newFinish,
        newDuration: proposed.newDuration,
        anchor,
        error: null,
        activeSprintName: findActiveSprintName(task),
      });
      if (ariaAssertiveRef.current) {
        ariaAssertiveRef.current.textContent = 'Resize pending. Confirm or cancel.';
      }
    });
  }, [engine, projectId, computeAnchor, findActiveSprintName, ariaAssertiveRef]);

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
            id: taskId,
            projectId,
            duration: newDuration,
            optimistic: { finish: newFinish, duration: newDuration },
          };
    rescheduleTask.mutate(payload, {
      onSuccess: () => {
        setState(null);
        onCommitSuccess?.();
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
    onCommitSuccess,
    ariaAssertiveRef,
  ]);

  // --- Project-start floor prompt handlers (#868) ---------------------------

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
          onCommitSuccess?.();
          if (ariaAssertiveRef.current) {
            ariaAssertiveRef.current.textContent = 'Snapped to the project start date.';
          }
        },
        onError: (err) => {
          setBeforeStartPrompt((prev) =>
            prev
              ? { ...prev, error: extractErrorMessage(err, "Couldn't save the change. Try again.") }
              : prev,
          );
        },
      },
    );
  }, [beforeStartPrompt, projectId, engine, rescheduleTask, onCommitSuccess, setScheduleError, ariaAssertiveRef]);

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
                onCommitSuccess?.();
                if (ariaAssertiveRef.current) {
                  ariaAssertiveRef.current.textContent =
                    'Project start moved; task scheduled.';
                }
              },
              onError: (err) => {
                setBeforeStartPrompt((prev) =>
                  prev
                    ? {
                        ...prev,
                        error: extractErrorMessage(
                          err,
                          'Moved the project start, but saving the task failed. Try again.',
                        ),
                      }
                    : prev,
                );
              },
            },
          );
        },
        onError: (err) => {
          setBeforeStartPrompt((prev) =>
            prev
              ? {
                  ...prev,
                  error: extractErrorMessage(
                    err,
                    "Couldn't move the project start date. You may not have permission.",
                  ),
                }
              : prev,
          );
        },
      },
    );
  }, [beforeStartPrompt, projectId, engine, updateProject, rescheduleTask, onCommitSuccess, setScheduleError, ariaAssertiveRef]);

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
