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
import { fetchWsTicket } from '@/api/wsTicket';

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

    function scheduleReconnect() {
      retryTimer = setTimeout(() => {
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        connect();
      }, backoffMs);
    }

    function connect() {
      if (!mountedRef.current) return;
      // Mint a single-use ticket then connect with ?ticket= (ADR-0141, #818) —
      // no JWT in the WebSocket URL. Single-use, so re-minted on each reconnect.
      void fetchWsTicket()
        .then((ticket) => {
          if (!mountedRef.current || !enabled) return;
          openSocket(ticket);
        })
        .catch(() => {
          if (!mountedRef.current || !enabled) return;
          // Don't retry into an expired session; otherwise back off and retry.
          if (useAuthStore.getState().sessionExpired) return;
          scheduleReconnect();
        });
    }

    function openSocket(ticket: string) {
      const url = `${WS_BASE}/ws/v1/projects/${projectId}/workshop/?ticket=${encodeURIComponent(ticket)}`;
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
        scheduleReconnect();
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
