/**
 * Tracks the live-update WebSocket connection state for the active project so
 * the StatusBar can tell the user whether their edits are reaching the server
 * (#643). TruePPM is offline-default, so a truthful connection signal — rather
 * than a permanently-green dot — is the point.
 *
 * The store owns the state machine. `useProjectWebSocket` calls the semantic
 * transition methods (`markConnecting`/`markLive`/`markDisconnected`/
 * `markFailed`) from the socket lifecycle callbacks — never from the
 * per-message handlers — so subscribers re-render only on an actual
 * connection-state change, not on every inbound event.
 */
import { create } from 'zustand';

/**
 * The connection states:
 * - `connecting`   — initial handshake (or idle, between projects); no socket open.
 * - `live`         — connected; edits broadcast and presence is accurate.
 * - `reconnecting` — a recent drop; actively retrying (first few attempts).
 * - `stale`        — a prolonged drop; the view may be out of date and edits
 *                    are not reaching the server.
 * - `failed`       — terminal; the session expired (close code 4001) and the
 *                    socket will not reconnect without re-authentication.
 * - `refused`      — terminal and NOT a fault: the server does not give this
 *                    caller's role live updates (close code 4003, or the project's
 *                    `can_subscribe_live` is false, so no socket was opened). The
 *                    view refreshes from REST on {@link REFUSED_POLL_INTERVAL_MS}
 *                    (#4375). Distinct from `stale` on purpose: `stale` says edits
 *                    are not reaching the server, which is untrue here.
 */
export type WsConnectionState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'stale'
  | 'failed'
  | 'refused';

/**
 * Close codes the project WebSocket sends AFTER accept, so a browser's
 * `CloseEvent.code` carries them (#4375; `apps/sync/consumers.py`). A refusal sent
 * before accept would arrive as 1006 and be indistinguishable from a network drop.
 */
export const WS_CLOSE_UNAUTHENTICATED = 4001;
export const WS_CLOSE_FORBIDDEN = 4003;

/** Fallback REST poll while the socket is not delivering events (down or connecting). */
export const FALLBACK_POLL_INTERVAL_MS = 30_000;

/**
 * Relaxed REST poll for a caller the socket refuses (#4375). A read-only role has
 * no live channel by design, so the view's only freshness source is this poll —
 * slow enough that an open Viewer tab is not a 30-second full-schedule refetch,
 * fast enough that the view does not silently freeze for the session.
 */
export const REFUSED_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * The `refetchInterval` a live-updated query should use in each connection state.
 * One function so every polling hook relaxes for `refused` identically.
 */
export function fallbackPollInterval(state: WsConnectionState): number | false {
  if (state === 'live') return false;
  if (state === 'refused') return REFUSED_POLL_INTERVAL_MS;
  return FALLBACK_POLL_INTERVAL_MS;
}

/**
 * Consecutive retryable disconnects after which the connection is treated as
 * `stale` rather than merely `reconnecting`. At the hook's 1s→2s→4s… backoff,
 * the third attempt means the socket has been down for ~7s — long enough that
 * the local view is likely out of date. Attempt-count based (not wall-clock) so
 * the machine is deterministic and timer-free under test.
 */
export const STALE_AFTER_ATTEMPTS = 3;

interface WsConnectionStoreState {
  state: WsConnectionState;
  /** Consecutive retryable disconnects since the last successful `markLive`. */
  reconnectAttempts: number;
  /** Initial handshake, or reset to idle when leaving a project. */
  markConnecting: () => void;
  /** Socket opened successfully — clears the reconnect counter. */
  markLive: () => void;
  /**
   * Socket closed for a retryable reason (network drop, server restart). Each
   * call increments the attempt counter; the state escalates from
   * `reconnecting` to `stale` once {@link STALE_AFTER_ATTEMPTS} is reached.
   */
  markDisconnected: () => void;
  /** Socket closed terminally (auth 4001 / session expired). */
  markFailed: () => void;
  /** The server does not give this caller live updates (4003 / `can_subscribe_live: false`). */
  markRefused: () => void;
}

export const useWsConnectionStore = create<WsConnectionStoreState>()((set) => ({
  state: 'connecting',
  reconnectAttempts: 0,

  markConnecting: () => set({ state: 'connecting', reconnectAttempts: 0 }),

  markLive: () => set({ state: 'live', reconnectAttempts: 0 }),

  markDisconnected: () =>
    set((s) => {
      const reconnectAttempts = s.reconnectAttempts + 1;
      return {
        reconnectAttempts,
        state: reconnectAttempts >= STALE_AFTER_ATTEMPTS ? 'stale' : 'reconnecting',
      };
    }),

  markFailed: () => set({ state: 'failed' }),

  markRefused: () => set({ state: 'refused', reconnectAttempts: 0 }),
}));
