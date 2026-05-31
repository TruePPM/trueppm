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
  setHasHydrated: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      isAuthenticated: false,
      sessionExpired: false,
      _hasHydrated: false,
      setAccessToken: (accessToken) =>
        set({ accessToken, isAuthenticated: true, sessionExpired: false }),
      clearTokens: () =>
        set({
          accessToken: null,
          isAuthenticated: false,
          sessionExpired: false,
        }),
      markSessionExpired: () =>
        set({
          accessToken: null,
          isAuthenticated: false,
          sessionExpired: true,
        }),
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
