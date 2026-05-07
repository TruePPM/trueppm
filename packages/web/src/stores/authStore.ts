import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  /** True when the access AND refresh tokens have been rejected and the
   *  user must log in again. Distinct from `isAuthenticated === false`,
   *  which also covers a clean logout. The session-expired banner reads
   *  this flag; `setTokens` clears it on successful re-login (#352). */
  sessionExpired: boolean;
  _hasHydrated: boolean;
  setTokens: (accessToken: string, refreshToken: string) => void;
  clearTokens: () => void;
  /** Triggered by the API 401 interceptor (after refresh fails) and by
   *  the WebSocket close handler on code 4001. Clears the cached tokens,
   *  flips `sessionExpired` to surface the banner, and leaves the user on
   *  the current screen so they don't lose context. */
  markSessionExpired: () => void;
  setHasHydrated: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      sessionExpired: false,
      _hasHydrated: false,
      setTokens: (accessToken, refreshToken) =>
        set({ accessToken, refreshToken, isAuthenticated: true, sessionExpired: false }),
      clearTokens: () =>
        set({
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
          sessionExpired: false,
        }),
      markSessionExpired: () =>
        set({
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
          sessionExpired: true,
        }),
      setHasHydrated: (value) => set({ _hasHydrated: value }),
    }),
    {
      name: 'trueppm-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
        // sessionExpired is intentionally excluded — a fresh tab should
        // never start in the expired state. The next 401 will set it.
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
