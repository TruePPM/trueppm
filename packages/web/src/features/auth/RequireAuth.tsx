import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuthStore } from '@/stores/authStore';

export function RequireAuth() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const hasHydrated = useAuthStore((s) => s._hasHydrated);
  const location = useLocation();

  // Block rendering until Zustand has rehydrated from localStorage.
  // Without this gate, v5's async hydration causes the first render to see
  // accessToken: null even when a valid token exists in storage, resulting in
  // the API interceptor sending requests without an Authorization header.
  if (!hasHydrated) return null;

  // When the session expires mid-app, isAuthenticated flips to false. Without
  // this branch the next render would Navigate to /login, unmounting AppShell
  // and along with it the SessionExpiredBanner — the user would land on the
  // login screen with no idea why (the exact regression #352 is fixing).
  // Hold the current screen so the banner can render; its Sign-in button is
  // the only path that actually navigates to /login (and clears the flag).
  if (sessionExpired) return <Outlet />;

  if (!isAuthenticated) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return <Outlet />;
}
