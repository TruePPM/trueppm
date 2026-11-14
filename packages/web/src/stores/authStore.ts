import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useLastTaskStore } from './lastTaskStore';
import { clearDemoSessionMarker } from '@/features/auth/demoMarker';
import { postAuthMessage } from '@/lib/authBroadcast';

/**
 * What the data layer knows at the instant a session ends. The store cannot import
 * the query client (it imports this store), so `lib/queryClient` registers a bridge.
 * `interrupted`: a write was in flight or paused, so something the user did may be
 * lost. `hasContent`: at least one query has data on screen to "continue viewing".
 * `clearCache`: drop every cached read (#4313).
 */
export interface SessionBridge {
  inspect: () => { interrupted: boolean; hasContent: boolean };
  clearCache: () => void;
}

let sessionBridge: SessionBridge | null = null;

export function registerSessionBridge(bridge: SessionBridge | null): void {
  sessionBridge = bridge;
}

/** Drop every cached read through the bridge. Used when a sibling tab signs out
 *  (#4296): the menu's sign-out clears its own tab's cache, and the receiving tab
 *  must not keep the previous user's data in memory either. */
export function clearSessionCache(): void {
  sessionBridge?.clearCache();
}

/** Options for the store actions that broadcast. Receivers of a broadcast pass
 *  `broadcast: false` so a change is never echoed back around the tabs. */
export interface BroadcastOption {
  broadcast?: boolean;
}

/** True for the rest of the task in which the first refused-write cue was shown. */
let cueJustShown = false;

/** How long cached data may stay on screen once the session is gone (#4313),
 *  measured from the moment it ended (`sessionEndedAt`), whether the modal or the
 *  read-only bar is showing. The server cannot be asked while expired, so an account
 *  deactivated in the meantime would otherwise stay readable for the life of the tab.
 *  Nothing the user does in the meantime extends it. */
export const READ_ONLY_VIEW_WINDOW_MS = 15 * 60 * 1000;

interface AuthState {
  /** Short-lived JWT access token. Held in memory only and never persisted to
   *  localStorage (#897): the refresh token now lives in an httpOnly cookie the
   *  browser sends only to the refresh endpoint, so the only credential in JS is
   *  this short-lived access token, which dies with the tab. On a fresh page
   *  load `accessToken` is null; the first API 401 triggers a cookie-based
   *  refresh that re-populates it (see api/client.ts). */
  accessToken: string | null;
  isAuthenticated: boolean;
  /** True when the session can no longer be refreshed and the user must log in
   *  again. Distinct from `isAuthenticated === false`, which also covers a clean
   *  logout. The session-expired banner reads this flag; `setAccessToken` clears
   *  it on a successful (re-)authentication (#352). */
  sessionExpired: boolean;
  /** True once the user has clicked "Continue viewing (read-only)" on the
   *  blocking re-auth gate (#1922). Only meaningful while `sessionExpired` is
   *  true: it downgrades `SessionExpiredBanner` from a focus-trapped modal to a
   *  slim persistent banner so already-cached read-only content stays reachable.
   *  Always reset to `false` on a fresh expiry or a successful (re-)auth, so a
   *  new session-expired event never inherits a stale acknowledgment. */
  sessionExpiredReadOnly: boolean;
  /** Whether "Continue viewing" is offered: false when the session ended before any
   *  content had loaded in this tab (cold load, #4313) or once the read-only window
   *  lapsed and the cache was cleared. Only meaningful while `sessionExpired`. */
  sessionExpiredCanView: boolean;
  /** A write was in flight or paused when the session ended, or was refused after
   *  it did (#4316). Selects the modal's "your last change did not go through" copy. */
  sessionExpiredInterrupted: boolean;
  /** The first refused write in read-only mode gets a light toast; only a repeat
   *  re-opens the blocking modal (#4316). Reset on entering read-only mode. */
  readOnlyWriteCueShown: boolean;
  /** The user chose read-only from the modal, so the banner takes focus from it. False
   *  when the banner appeared on its own (#4316): stealing focus mid-edit would be worse. */
  focusReadOnlyBar: boolean;
  /** When this tab learned the session ended (epoch ms), for the view window (#4313).
   *  Set only on a FRESH expiry; entering read-only mode, a refused write and a
   *  sibling tab's broadcast never move it, so the window cannot be extended. */
  sessionEndedAt: number | null;
  /** This tab has waited over a second on a sibling tab's refresh lock (#4296). */
  waitingOnSiblingTab: boolean;
  /** True after an explicit sign-out in this page load. In memory only. The silent
   *  demo re-login (#4500) reads it so signing out of the demo is never undone by the
   *  route guard re-signing the visitor in. Cleared by any successful sign-in. */
  signedOut: boolean;
  _hasHydrated: boolean;
  /** Store the access token in memory after login or a successful refresh. The
   *  refresh token is not passed here — it is set/rotated server-side as an
   *  httpOnly cookie (#897). */
  setAccessToken: (accessToken: string, opts?: BroadcastOption) => void;
  clearTokens: (opts?: BroadcastOption) => void;
  /** Triggered by the API 401 interceptor (after refresh fails) and by the
   *  WebSocket close handler on code 4001. Clears the in-memory access token,
   *  flips `sessionExpired` to surface the banner, and leaves the user on the
   *  current screen so they don't lose context. */
  markSessionExpired: (opts?: BroadcastOption) => void;
  /** Called from the "Continue viewing (read-only)" action (#1922): releases
   *  the focus trap and swaps the blocking modal for a persistent banner
   *  without touching `sessionExpired` — the user is still logged out, they
   *  have just chosen to keep looking at cached content in the meantime. */
  enterReadOnlyMode: (opts?: BroadcastOption) => void;
  /** Called when a mutation is attempted while `sessionExpiredReadOnly` is true
   *  (#1922): the API interceptor already blocked the request before it left
   *  the browser, so this only re-engages the blocking modal/focus-trap rather
   *  than letting the write fail silently or loop. No-ops if the session is not
   *  currently in read-only mode. */
  reassertSessionExpired: () => 'cue' | 'modal' | 'none';
  /** The read-only view window lapsed (#4313): drop every cached read and fall back
   *  to the blocking modal with only "Sign in", so nothing stays on screen. */
  endReadOnlyViewing: () => void;
  setWaitingOnSiblingTab: (waiting: boolean) => void;
  setHasHydrated: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      isAuthenticated: false,
      sessionExpired: false,
      sessionExpiredReadOnly: false,
      sessionExpiredCanView: true,
      sessionExpiredInterrupted: false,
      readOnlyWriteCueShown: false,
      sessionEndedAt: null,
      focusReadOnlyBar: false,
      waitingOnSiblingTab: false,
      signedOut: false,
      _hasHydrated: false,
      setAccessToken: (accessToken, opts) => {
        // Only a null -> token transition is news to sibling tabs: a rotation while a
        // token is already held changes nothing they can act on.
        const wasTokenless = get().accessToken === null;
        set({
          accessToken,
          isAuthenticated: true,
          sessionExpired: false,
          sessionExpiredReadOnly: false,
          sessionExpiredCanView: true,
          sessionExpiredInterrupted: false,
          readOnlyWriteCueShown: false,
          sessionEndedAt: null,
          signedOut: false,
        });
        if (wasTokenless && opts?.broadcast !== false) postAuthMessage('restored');
      },
      clearTokens: (opts) => {
        // Every sign-out path funnels through here (menu, session-expired banner,
        // workspace deletion). The last-opened drawer task is the previous user's
        // and the store outlives the shell, so drop it before anyone else signs in
        // (#1211). Cleared on the store, not in a component, because RequireAuth
        // unmounts the shell on sign-out and a component-held guard would reset.
        useLastTaskStore.setState({ opened: null });
        clearDemoSessionMarker();
        // An explicit sign-out in a healthy session signs out every tab. Leaving an
        // already-expired session for /login must NOT: the sibling tabs should stay
        // put and recover when the restored message arrives (#4296).
        const explicitSignOut = !get().sessionExpired;
        set({
          accessToken: null,
          isAuthenticated: false,
          sessionExpired: false,
          sessionExpiredReadOnly: false,
          sessionExpiredCanView: true,
          sessionExpiredInterrupted: false,
          readOnlyWriteCueShown: false,
          sessionEndedAt: null,
          signedOut: true,
        });
        if (explicitSignOut && opts?.broadcast !== false) postAuthMessage('cleared');
      },
      markSessionExpired: (opts) => {
        // Already expired: the first call decided the UI and started the view window.
        // A second one (concurrent 401s, a WS 4001 after an API 401) must not restart
        // the window, re-open a modal the user dismissed, or re-broadcast (#4313).
        if (get().sessionExpired) return;
        useLastTaskStore.setState({ opened: null });
        // The modal is for a session that ended with something at stake: a write in
        // flight, or nothing yet loaded to fall back on. Otherwise go straight to the
        // quiet read-only banner (#4316). With no bridge registered, keep the modal.
        const ctx = sessionBridge?.inspect() ?? { interrupted: true, hasContent: true };
        set({
          accessToken: null,
          isAuthenticated: false,
          sessionExpired: true,
          sessionExpiredReadOnly: ctx.hasContent && !ctx.interrupted,
          sessionExpiredCanView: ctx.hasContent,
          sessionExpiredInterrupted: ctx.interrupted,
          readOnlyWriteCueShown: false,
          sessionEndedAt: Date.now(),
          focusReadOnlyBar: false,
        });
        if (opts?.broadcast !== false) postAuthMessage('expired');
      },
      enterReadOnlyMode: (opts) => {
        const state = get();
        // Nothing to view once the window lapsed or on a cold load (#4313).
        if (!state.sessionExpired || !state.sessionExpiredCanView) return;
        set({
          sessionExpiredReadOnly: true,
          readOnlyWriteCueShown: false,
          // A sibling tab's choice must not pull focus here.
          focusReadOnlyBar: opts?.broadcast !== false,
        });
        if (opts?.broadcast !== false) postAuthMessage('readonly');
      },
      reassertSessionExpired: () => {
        const state = get();
        if (!state.sessionExpired || !state.sessionExpiredReadOnly) return 'none';
        // First refused write: a light cue (the caller toasts), not the full-viewport
        // modal a misclick on an editable cell would otherwise summon (#4316).
        if (!state.readOnlyWriteCueShown) {
          set({ readOnlyWriteCueShown: true });
          cueJustShown = true;
          setTimeout(() => {
            cueJustShown = false;
          }, 0);
          return 'cue';
        }
        // One action that fires two writes at once refuses both in the same tick; the
        // second is the same misclick, not a repeat, so it must not escalate.
        if (cueJustShown) return 'none';
        set({
          sessionExpiredReadOnly: false,
          sessionExpiredInterrupted: true,
        });
        return 'modal';
      },
      endReadOnlyViewing: () => {
        if (!get().sessionExpired) return;
        sessionBridge?.clearCache();
        // `sessionEndedAt` stays: it is the record of when this session ended, and
        // `sessionExpiredCanView: false` is what keeps the view from coming back.
        set({
          sessionExpiredReadOnly: false,
          sessionExpiredCanView: false,
          sessionExpiredInterrupted: false,
        });
      },
      setWaitingOnSiblingTab: (waiting) => set({ waitingOnSiblingTab: waiting }),
      setHasHydrated: (value) => set({ _hasHydrated: value }),
    }),
    {
      name: 'trueppm-auth',
      // Persist only the non-sensitive `isAuthenticated` hint so a fresh tab can
      // optimistically render the app shell and let the cookie-based refresh
      // re-mint an access token. Tokens are NEVER persisted (#897): the access
      // token stays in memory, the refresh token lives in an httpOnly cookie.
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
        // accessToken is intentionally excluded — in memory only.
        // sessionExpired is intentionally excluded — a fresh tab should never
        // start in the expired state. The next 401 will set it.
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
