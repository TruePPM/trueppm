/**
 * Connects to the project WebSocket channel and dispatches incoming events.
 *
 * Events handled:
 *   cpm_queued    → schedulerStore.setRecalculating(true)
 *   cpm_complete  → invalidate tasks query, schedulerStore.setCpmComplete()
 *   cpm_error     → schedulerStore.setCpmError()
 *   task_created / task_updated / task_deleted → invalidate tasks query
 *   baseline_created / baseline_activated / baseline_deleted → invalidate baselines + tasks
 *
 * Reconnects with exponential backoff (1s → 2s → 4s → … up to 30s).
 * Stops reconnecting when `projectId` is null/undefined or the token is absent.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { useSchedulerStore } from '@/stores/schedulerStore';
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

      if (event_type === 'cpm_queued') {
        setRecalculating(true);
      } else if (event_type === 'cpm_complete') {
        const projectFinish = typeof payload.project_finish === 'string' ? payload.project_finish : new Date().toISOString();
        setCpmComplete(projectFinish);
        void queryClient.invalidateQueries({ queryKey: ['tasks', projectIdRef.current] });
        void queryClient.invalidateQueries({ queryKey: ['shellStats', projectIdRef.current] });
      } else if (event_type === 'cpm_error') {
        setCpmError(payload as unknown as CpmError);
      } else if (
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
