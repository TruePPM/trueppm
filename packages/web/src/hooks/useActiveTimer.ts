/**
 * Live running-timer state for task time entry (#1415, ADR-0185 §4).
 *
 * A contributor starts a timer on a task; a header chip shows the running
 * elapsed app-wide; stopping writes a `TimeEntry`. The timer is a **server**
 * singleton (exactly one active timer per user, persisted so it survives
 * reload / navigation / device switch), so the authoritative fact is the
 * server's `started_at` — the client only *derives* elapsed from it, never
 * accumulates locally (no drift, no dual source of truth).
 *
 * That server-authoritative shape is why this uses TanStack Query as the single
 * source of truth (not Zustand): "reconcile against the server on mount" is just
 * a refetch, and `refetchOnWindowFocus` gives multi-device continuity for free
 * (ADR-0185 §4). The live seconds tick is a pure display concern — see
 * `useElapsedSeconds` — kept out of this hook so row consumers that only care
 * *whether* a task is running do not re-render every second.
 *
 * Second-start is delegated to the server: `POST timer/start` on task B while A
 * runs atomically stops+logs A and returns the finalized entry, which we surface
 * as an Undo toast. Stop is optimistic with rollback.
 */
import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast';
import { formatLoggedMinutes } from '@/lib/formatElapsed';

/** Query key for the caller's active timer (server singleton). */
export const ACTIVE_TIMER_KEY = ['activeTimer'] as const;

/** The running timer as returned by `GET /me/timer/` (active branch). */
export interface ActiveTimer {
  id: string;
  task: string;
  task_short_id: string;
  task_name: string;
  project: string;
  started_at: string;
  /** Server-computed at fetch time; the live clock derives from `started_at`. */
  elapsed_seconds: number;
  note: string;
  /** Elapsed exceeded the stale ceiling — the UI nudges rather than logs a weekend. */
  stale: boolean;
}

/** A finalized `TimeEntry` (stop, or the auto-logged prior timer on second-start). */
export interface LoggedEntry {
  id: string;
  task: string;
  minutes: number;
  entry_date: string;
  note: string;
  source: string;
  server_version: number;
  created_at: string;
}

interface TimerGetResponse {
  active: boolean;
  id?: string;
  task?: string;
  task_short_id?: string;
  task_name?: string;
  project?: string;
  started_at?: string;
  elapsed_seconds?: number;
  note?: string;
  stale?: boolean;
}

interface StartResponse {
  active_timer: ActiveTimer;
  finalized_entry: LoggedEntry | null;
}

interface StartVars {
  taskId: string;
  note?: string;
}

async function fetchActiveTimer(): Promise<ActiveTimer | null> {
  const { data } = await apiClient.get<TimerGetResponse>('/me/timer/');
  if (!data.active) return null;
  // The active branch carries every ActiveTimer field alongside `active: true`;
  // the extra flag is inert for consumers (they read named fields only).
  return data as unknown as ActiveTimer;
}

/**
 * Live-ticking elapsed seconds derived from a server `started_at` ISO string.
 *
 * Returns whole seconds since `started_at`, re-computed once per second from the
 * wall clock — so the value is always the true elapsed, immune to a missed tick
 * or a backgrounded tab (unlike a client-accumulated counter). Returns 0 when no
 * timer is running. Clamps a brief future `started_at` (clock skew) to 0.
 */
export function useElapsedSeconds(startedAt: string | null | undefined): number {
  const compute = useCallback(() => {
    if (!startedAt) return 0;
    const startMs = Date.parse(startedAt);
    if (Number.isNaN(startMs)) return 0;
    return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  }, [startedAt]);

  const [elapsed, setElapsed] = useState(compute);

  useEffect(() => {
    setElapsed(compute());
    if (!startedAt) return;
    const id = setInterval(() => setElapsed(compute()), 1000);
    return () => clearInterval(id);
  }, [compute, startedAt]);

  return elapsed;
}

function isConflict(error: unknown): boolean {
  return error instanceof AxiosError && error.response?.status === 409;
}

function isForbidden(error: unknown): boolean {
  return error instanceof AxiosError && error.response?.status === 403;
}

/**
 * Access the running timer and the start/stop actions.
 *
 * Consumers:
 *   - the header `TimerChip` (reads `timer`, calls `stopTimer`),
 *   - the My Work row affordance (reads `isTaskRunning`, calls `startTimer` /
 *     `stopTimer`).
 *
 * Stop clears the cache optimistically and rolls back on error; both stop and a
 * second-start surface a success toast with **Undo** that deletes the freshly
 * logged entry.
 */
export function useActiveTimer() {
  const qc = useQueryClient();

  const { data: timer = null, isLoading } = useQuery({
    queryKey: ACTIVE_TIMER_KEY,
    queryFn: fetchActiveTimer,
    // The timer is a cross-device fact; refetch on focus reconciles a timer
    // started on another device (ADR-0185 §4). Always considered stale so a
    // remount re-reads the authoritative clock.
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const undo = useMutation({
    mutationFn: async (entryId: string) => {
      await apiClient.delete(`/me/time-entries/${entryId}/`);
    },
    onSuccess: () => toast.info('Time entry removed.'),
    onError: () => toast.error('Could not remove the entry. Please try again.'),
  });

  /** Success toast for a freshly logged entry with a single Undo (delete) action. */
  const logToast = useCallback(
    (entry: LoggedEntry, taskLabel: string) => {
      const logged = formatLoggedMinutes(entry.minutes);
      toast.action(
        `Logged ${logged} on ${taskLabel}`,
        {
          label: 'Undo',
          ariaLabel: `Undo — remove the ${logged} entry logged on ${taskLabel}`,
          onClick: () => undo.mutate(entry.id),
        },
        { variant: 'success' },
      );
    },
    [undo],
  );

  const start = useMutation({
    mutationFn: async ({ taskId, note }: StartVars): Promise<StartResponse> => {
      const { data } = await apiClient.post<StartResponse>('/me/timer/start', {
        task: taskId,
        ...(note ? { note } : {}),
      });
      return data;
    },
    onSuccess: (data) => {
      // The cache still holds the *prior* timer (if any) — read its name for the
      // second-start Undo toast before overwriting with the new one.
      const prior = qc.getQueryData<ActiveTimer | null>(ACTIVE_TIMER_KEY);
      qc.setQueryData(ACTIVE_TIMER_KEY, data.active_timer);
      if (data.finalized_entry && prior) {
        logToast(data.finalized_entry, `${prior.task_short_id} · ${prior.task_name}`);
      }
    },
    onError: (error) => {
      if (isForbidden(error)) {
        toast.error("You don't have permission to log time on this project.");
        return;
      }
      toast.error('Could not start the timer. Please try again.');
    },
  });

  const stop = useMutation({
    mutationFn: async (): Promise<LoggedEntry> => {
      const { data } = await apiClient.post<LoggedEntry>('/me/timer/stop');
      return data;
    },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ACTIVE_TIMER_KEY });
      const prior = qc.getQueryData<ActiveTimer | null>(ACTIVE_TIMER_KEY);
      // Optimistic: the chip/row drop out of the running state immediately.
      qc.setQueryData(ACTIVE_TIMER_KEY, null);
      return { prior };
    },
    onSuccess: (entry, _vars, ctx) => {
      if (ctx?.prior) {
        logToast(entry, `${ctx.prior.task_short_id} · ${ctx.prior.task_name}`);
      }
    },
    onError: (error, _vars, ctx) => {
      // 409 = the timer was already stopped (e.g. another device / a double
      // click): the optimistic clear is already correct, so keep it, no error.
      if (isConflict(error)) {
        void qc.invalidateQueries({ queryKey: ACTIVE_TIMER_KEY });
        return;
      }
      if (ctx?.prior !== undefined) qc.setQueryData(ACTIVE_TIMER_KEY, ctx.prior);
      toast.error('Could not stop the timer. Please try again.');
    },
  });

  const startTimer = useCallback(
    (taskId: string, note?: string) => start.mutate({ taskId, note }),
    [start],
  );
  const stopTimer = useCallback(() => stop.mutate(), [stop]);
  const isTaskRunning = useCallback((taskId: string) => timer?.task === taskId, [timer]);

  return {
    timer,
    isRunning: timer != null,
    isLoading,
    startTimer,
    stopTimer,
    isTaskRunning,
    isStarting: start.isPending,
    isStopping: stop.isPending,
  };
}
