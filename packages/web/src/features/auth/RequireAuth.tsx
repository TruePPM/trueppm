import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { bootstrapAccessToken } from '@/api/client';
import { useAuthStore } from '@/stores/authStore';

export function RequireAuth() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const hasHydrated = useAuthStore((s) => s._hasHydrated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const location = useLocation();

  // After a fresh page load the access token is in memory only and starts null
  // (#897); `isAuthenticated` is a persisted hint that survives the reload. When
  // we still believe we're authenticated but hold no token, mint one from the
  // httpOnly refresh cookie BEFORE rendering the app, so the first wave of data
  // queries carries a token instead of triggering a 401 storm (and a WebSocket
  // reconnect thrash) on every reload/deep-link (#911).
  const needsBootstrap = hasHydrated && isAuthenticated && !sessionExpired && !accessToken;
  const [bootstrapAttempted, setBootstrapAttempted] = useState(false);

  useEffect(() => {
    if (!needsBootstrap || bootstrapAttempted) return;
    let cancelled = false;
    void bootstrapAccessToken().finally(() => {
      if (!cancelled) setBootstrapAttempted(true);
    });
    return () => {
      cancelled = true;
    };
  }, [needsBootstrap, bootstrapAttempted]);

  // Block rendering until Zustand has rehydrated from localStorage.
  // Without this gate, v5's async hydration causes the first render to see
  // accessToken: null even when a valid token exists in storage, resulting in
  // the API interceptor sending requests without an Authorization header.
  if (!hasHydrated) return null;

  // Hold rendering while the one-shot bootstrap refresh is in flight so no child
  // query mounts and fires before the minted token lands (#911). On success
  // `accessToken` is set and `needsBootstrap` flips false; on failure
  // `sessionExpired` flips true (handled below).
  if (needsBootstrap && !bootstrapAttempted) return null;

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
