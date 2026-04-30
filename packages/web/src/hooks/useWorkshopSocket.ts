/**
 * Workshop WebSocket hook — connects to the project's workshop channel and
 * relays cursor/edit events between participants.
 *
 * Only opens the socket when both projectId and accessToken are available AND
 * the caller passes enabled=true (i.e. an active workshop session exists and
 * the board is in workshop mode).
 *
 * Returns sendMessage() to dispatch events (cursor moves, phase_rename, etc.)
 * and the latest received event from other participants.
 */
import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/stores/authStore';

export interface WorkshopEvent {
  type: string;
  user_id?: string;
  display_name?: string;
  [key: string]: unknown;
}

const WS_BASE = (() => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
})();

const MAX_BACKOFF_MS = 30_000;

export function useWorkshopSocket(
  projectId: string | null | undefined,
  enabled: boolean,
  onEvent: (event: WorkshopEvent) => void,
) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Stable send function that the caller can use to dispatch events.
  const [send] = useState(() => (msg: WorkshopEvent) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !projectId || !accessToken) return;

    let backoffMs = 1_000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (!mountedRef.current) return;
      const url = `${WS_BASE}/ws/v1/projects/${projectId}/workshop/?token=${encodeURIComponent(accessToken ?? '')}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.addEventListener('message', (e: MessageEvent<string>) => {
        try {
          const evt = JSON.parse(e.data) as WorkshopEvent;
          onEventRef.current(evt);
        } catch {
          // ignore malformed frames
        }
      });

      ws.addEventListener('open', () => {
        backoffMs = 1_000;
      });

      ws.addEventListener('close', () => {
        wsRef.current = null;
        if (!mountedRef.current || !enabled) return;
        retryTimer = setTimeout(() => {
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          connect();
        }, backoffMs);
      });
    }

    connect();

    return () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled, projectId, accessToken]);

  return { send };
}
