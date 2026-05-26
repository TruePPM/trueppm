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
 * The five connection states, in increasing severity:
 * - `connecting`   — initial handshake (or idle, between projects); no socket open.
 * - `live`         — connected; edits broadcast and presence is accurate.
 * - `reconnecting` — a recent drop; actively retrying (first few attempts).
 * - `stale`        — a prolonged drop; the view may be out of date and edits
 *                    are not reaching the server.
 * - `failed`       — terminal; the session expired (close code 4001) and the
 *                    socket will not reconnect without re-authentication.
 */
export type WsConnectionState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'stale'
  | 'failed';

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
}));
