import { useCallback, useState } from 'react';

import { useUpdateTask } from '@/hooks/useTaskMutations';
import type { Task } from '@/types';

/**
 * The two remediation writes for a task flagged "no committed start" (ADR-0603).
 *
 * Both are CPM-recompute writes, so they commit instantly (web-rule 217's
 * DurationCell carve-out — no deferred Save bar) and are guarded against offline
 * (rule 29): the schedule can only be recomputed server-side, so a queued write
 * we cannot recompute is worse than a blocked one.
 *
 * Server behaviour is verified in ADR-0603: because the task is already
 * `IN_PROGRESS`, `PATCH { planned_start }` does not re-trip the date-gated
 * auto-promote, and `PATCH { status: 'NOT_STARTED' }` sticks (the promote needs
 * `planned_start <= today`, which is null here). `usePromoteTask` is the
 * *promote*-direction hook and is deliberately not used — this is a demote.
 *
 * Shared by the chip popover (#2313) and the drawer advisory that lands with the
 * Task Detail Drawer v2 redesign (#2315) — build the write path once.
 */
export interface CommitStartOrTodo {
  /** Commit the CPM-computed start as the PM baseline: `PATCH { planned_start: task.start }`. */
  commitStart: () => void;
  /** Demote the task back to To Do: `PATCH { status: 'NOT_STARTED' }`. */
  moveToTodo: () => void;
  /** True while either write is in flight. */
  isPending: boolean;
  /** Offline / server error message for the current attempt, or `null`. */
  error: string | null;
  /** Clear the error (e.g. when the surface is re-opened). */
  clearError: () => void;
}

export function useCommitStartOrTodo(task: Task, projectId: string): CommitStartOrTodo {
  const updateTask = useUpdateTask();
  const [error, setError] = useState<string | null>(null);

  const guardOnline = useCallback((): boolean => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError("You're offline — reconnect to change the schedule.");
      return false;
    }
    return true;
  }, []);

  const commitStart = useCallback(() => {
    if (!guardOnline()) return;
    if (!task.start) {
      setError('This task has no calculated start date to commit yet.');
      return;
    }
    setError(null);
    updateTask.mutate(
      { id: task.id, projectId, planned_start: task.start },
      { onError: () => setError('Could not set the committed start. Try again.') },
    );
  }, [guardOnline, task.start, task.id, projectId, updateTask]);

  const moveToTodo = useCallback(() => {
    if (!guardOnline()) return;
    setError(null);
    updateTask.mutate(
      { id: task.id, projectId, status: 'NOT_STARTED' },
      { onError: () => setError('Could not move the task to To Do. Try again.') },
    );
  }, [guardOnline, task.id, projectId, updateTask]);

  const clearError = useCallback(() => setError(null), []);

  return {
    commitStart,
    moveToTodo,
    isPending: updateTask.isPending,
    error,
    clearError,
  };
}
