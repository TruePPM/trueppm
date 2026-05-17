import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useRescheduleTask } from '@/hooks/useTaskMutations';
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

export interface UseScheduleCommitOptions {
  engine: GanttEngine | null;
  projectId: string | null;
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
  visibleTasks,
  allTasks,
  sprints,
  canvasContainerRef,
  ariaAssertiveRef,
  onCommitSuccess,
}: UseScheduleCommitOptions): UseScheduleCommitApi {
  const [state, setState] = useState<ScheduleCommitState | null>(null);
  const rescheduleTask = useRescheduleTask();
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
  }, [state, projectId, rescheduleTask, revertEngine, setScheduleError, onCommitSuccess, ariaAssertiveRef]);

  return {
    state,
    isPending: rescheduleTask.isPending,
    handleConfirm,
    handleCancel,
    handleDismissByOutsideClick,
  };
}
