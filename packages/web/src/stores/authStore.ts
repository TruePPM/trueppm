import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  _hasHydrated: boolean;
  /** Store the access token in memory after login or a successful refresh. The
   *  refresh token is not passed here — it is set/rotated server-side as an
   *  httpOnly cookie (#897). */
  setAccessToken: (accessToken: string) => void;
  clearTokens: () => void;
  /** Triggered by the API 401 interceptor (after refresh fails) and by the
   *  WebSocket close handler on code 4001. Clears the in-memory access token,
   *  flips `sessionExpired` to surface the banner, and leaves the user on the
   *  current screen so they don't lose context. */
  markSessionExpired: () => void;
  /** Called from the "Continue viewing (read-only)" action (#1922): releases
   *  the focus trap and swaps the blocking modal for a persistent banner
   *  without touching `sessionExpired` — the user is still logged out, they
   *  have just chosen to keep looking at cached content in the meantime. */
  enterReadOnlyMode: () => void;
  /** Called when a mutation is attempted while `sessionExpiredReadOnly` is true
   *  (#1922): the API interceptor already blocked the request before it left
   *  the browser, so this only re-engages the blocking modal/focus-trap rather
   *  than letting the write fail silently or loop. No-ops if the session is not
   *  currently in read-only mode. */
  reassertSessionExpired: () => void;
  setHasHydrated: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      isAuthenticated: false,
      sessionExpired: false,
      sessionExpiredReadOnly: false,
      _hasHydrated: false,
      setAccessToken: (accessToken) =>
        set({
          accessToken,
          isAuthenticated: true,
          sessionExpired: false,
          sessionExpiredReadOnly: false,
        }),
      clearTokens: () =>
        set({
          accessToken: null,
          isAuthenticated: false,
          sessionExpired: false,
          sessionExpiredReadOnly: false,
        }),
      markSessionExpired: () =>
        set({
          accessToken: null,
          isAuthenticated: false,
          sessionExpired: true,
          // A fresh expiry always starts at the blocking modal, even if a
          // previous expiry in this tab had been acknowledged into read-only.
          sessionExpiredReadOnly: false,
        }),
      enterReadOnlyMode: () => set({ sessionExpiredReadOnly: true }),
      reassertSessionExpired: () =>
        set((state) => (state.sessionExpiredReadOnly ? { sessionExpiredReadOnly: false } : {})),
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
