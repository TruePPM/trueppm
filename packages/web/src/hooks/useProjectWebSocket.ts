/**
 * Connects to the project WebSocket channel and dispatches incoming events.
 *
 * Events handled:
 *   task_run_started  → taskRunStore.addRun(); for scheduling tasks also setRecalculating(true)
 *   task_run_progress → taskRunStore.updateProgress()
 *   task_run_completed → taskRunStore.completeRun(); for scheduling tasks also setCpmComplete()
 *   task_run_failed   → taskRunStore.failRun(); for scheduling tasks also setCpmError()
 *   task_run_cancelled → taskRunStore.cancelRun()
 *   cpm_complete      → invalidate tasks query, schedulerStore.setCpmComplete() (compat broadcast)
 *   task_created / task_updated / task_deleted → invalidate tasks query
 *   baseline_created / baseline_activated / baseline_deleted → invalidate baselines + tasks
 *
 * Reconnects with exponential backoff (1s → 2s → 4s → … up to 30s).
 * Stops reconnecting when `projectId` is null/undefined or the token is absent.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSchedulerStore } from '@/stores/schedulerStore';
import { useTaskRunStore } from '@/stores/taskRunStore';
import type { CpmError } from '@/stores/schedulerStore';

interface WsEnvelope {
  event_type: string;
  payload: Record<string, unknown>;
}

const WS_BASE = (() => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
})();

const MAX_BACKOFF_MS = 30_000;

export function useProjectWebSocket(projectId: string | null | undefined): void {
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((s) => s.accessToken);
  const setRecalculating = useSchedulerStore((s) => s.setRecalculating);
  const setCpmError = useSchedulerStore((s) => s.setCpmError);
  const setCpmComplete = useSchedulerStore((s) => s.setCpmComplete);
  const addRun = useTaskRunStore((s) => s.addRun);
  const updateProgress = useTaskRunStore((s) => s.updateProgress);
  const completeRun = useTaskRunStore((s) => s.completeRun);
  const failRun = useTaskRunStore((s) => s.failRun);
  const cancelRun = useTaskRunStore((s) => s.cancelRun);
  const addPresenceUser = usePresenceStore((s) => s.addUser);
  const removePresenceUser = usePresenceStore((s) => s.removeUser);

  // Stable refs so the reconnect loop doesn't capture stale closures.
  const projectIdRef = useRef(projectId);
  const tokenRef = useRef(accessToken);
  projectIdRef.current = projectId;
  tokenRef.current = accessToken;

  // Track whether the component is still mounted so we don't reconnect after unmount.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!projectId || !accessToken) return;

    let ws: WebSocket | null = null;
    let backoffMs = 1_000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function handleMessage(event: MessageEvent<string>) {
      let envelope: WsEnvelope;
      try {
        envelope = JSON.parse(event.data) as WsEnvelope;
      } catch {
        return;
      }

      const { event_type, payload } = envelope;

      // --- Task run progress events ---
      if (event_type === 'task_run_started') {
        const taskRunId = payload.task_run_id as string;
        const taskName = payload.task_name as string;
        const pid = (payload.project_id as string | null) ?? null;
        addRun({ taskRunId, taskName, projectId: pid, pct: 0, msg: '', status: 'running' });
        // Scheduling integration: signal CPM is running.
        if (taskName === 'scheduling.recalculate') {
          setRecalculating(true);
        }
      } else if (event_type === 'task_run_progress') {
        const taskRunId = payload.task_run_id as string;
        const pct = typeof payload.pct === 'number' ? payload.pct : 0;
        const msg = typeof payload.msg === 'string' ? payload.msg : '';
        updateProgress(taskRunId, pct, msg);
      } else if (event_type === 'task_run_completed') {
        const taskRunId = payload.task_run_id as string;
        const resultSummary = (payload.result_summary as Record<string, unknown> | null) ?? null;
        completeRun(taskRunId, resultSummary);
        // task_run_completed from the scheduler carries result_summary with project_finish.
        // cpm_complete is still also broadcast for compatibility; this handles the task_run path.
        if (resultSummary && typeof resultSummary.project_finish === 'string') {
          setCpmComplete(resultSummary.project_finish);
          void queryClient.invalidateQueries({ queryKey: ['tasks', projectIdRef.current] });
          void queryClient.invalidateQueries({ queryKey: ['shellStats', projectIdRef.current] });
        }
      } else if (event_type === 'task_run_failed') {
        const taskRunId = payload.task_run_id as string;
        const errorDetail = typeof payload.error_detail === 'string' ? payload.error_detail : '';
        failRun(taskRunId, errorDetail);
        // Scheduling integration: if this was the CPM task, set error state.
        const run = useTaskRunStore.getState().runs[taskRunId];
        if (run?.taskName === 'scheduling.recalculate') {
          setCpmError({ error: 'internal_error', cycle: [] } as CpmError);
        }
      } else if (event_type === 'task_run_cancelled') {
        const taskRunId = payload.task_run_id as string;
        cancelRun(taskRunId);
      }

      // --- Presence events ---
      else if (event_type === 'presence.join') {
        const userId = payload.user_id as string;
        const displayName = (payload.display_name as string | undefined) ?? userId;
        addPresenceUser({ user_id: userId, display_name: displayName });
      } else if (event_type === 'presence.leave') {
        removePresenceUser(payload.user_id as string);
      }

      // --- Legacy CPM compat broadcast ---
      else if (event_type === 'cpm_complete') {
        // cpm_complete is still emitted by the scheduler for any client that hasn't
        // migrated to task_run_completed. Handle it here so nothing breaks during
        // the transition period.
        const projectFinish =
          typeof payload.project_finish === 'string'
            ? payload.project_finish
            : new Date().toISOString();
        setCpmComplete(projectFinish);
        void queryClient.invalidateQueries({ queryKey: ['tasks', projectIdRef.current] });
        void queryClient.invalidateQueries({ queryKey: ['shellStats', projectIdRef.current] });
      }

      // --- Mutation events ---
      else if (
        event_type === 'task_created' ||
        event_type === 'task_updated' ||
        event_type === 'task_deleted'
      ) {
        void queryClient.invalidateQueries({ queryKey: ['tasks', projectIdRef.current] });
      } else if (
        event_type === 'baseline_created' ||
        event_type === 'baseline_activated' ||
        event_type === 'baseline_deleted'
      ) {
        void queryClient.invalidateQueries({ queryKey: ['baselines', projectIdRef.current] });
        // Active baseline change affects the task overlay annotation.
        if (event_type === 'baseline_activated' || event_type === 'baseline_deleted') {
          void queryClient.invalidateQueries({ queryKey: ['tasks', projectIdRef.current] });
        }
      }
    }

    function connect() {
      if (!mountedRef.current) return;

      const pid = projectIdRef.current;
      const token = tokenRef.current;
      if (!pid || !token) return;

      const url = `${WS_BASE}/ws/v1/projects/${pid}/?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(url);

      ws.addEventListener('message', handleMessage);

      ws.addEventListener('close', () => {
        if (!mountedRef.current) return;
        // Exponential backoff reconnect
        retryTimer = setTimeout(() => {
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          connect();
        }, backoffMs);
      });

      ws.addEventListener('open', () => {
        backoffMs = 1_000; // reset on successful connection
      });
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (ws) {
        ws.removeEventListener('message', handleMessage);
        ws.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, accessToken]);
}
