import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { bootstrapAccessToken } from '@/api/client';
import { useAuthStore } from '@/stores/authStore';
import { silentDemoLogin } from './demoSession';

/** One silent demo re-login per page load, across remounts — a failed one must not loop (#4500). */
let silentDemoAttempted = false;

/** Test seam: forget the per-page-load attempt. */
export function resetSilentDemoAttempt(): void {
  silentDemoAttempted = false;
}

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

  // Silent demo re-login (#4500). The demo signs in session-only, so a reload or a
  // pasted deep link finds no session — either an expired one (bootstrap refresh
  // failed) or none at all. On a read-only demo host `silentDemoLogin` re-submits the
  // published credential so the visitor lands on the page the URL names instead of the
  // signed-out modal. Eligibility excludes an explicit sign-out and the bare origin
  // (the demo's front door keeps its Explore button); the module flag caps it at one
  // attempt per page load, and a failure falls through to the existing modal/redirect.
  const signedOut = useAuthStore((s) => s.signedOut);
  const [silent, setSilent] = useState<'idle' | 'running' | 'done'>('idle');
  const lostSession = sessionExpired || (!isAuthenticated && location.pathname !== '/');
  const silentEligible =
    hasHydrated && lostSession && !signedOut && !needsBootstrap && silent !== 'done';
  const silentPending = silentEligible && (silent === 'running' || !silentDemoAttempted);

  // The window is the page load only. Once the guard has seen a healthy (or
  // deliberately signed-out front-door) state, a later expiry mid-app must keep the
  // shell mounted for the modal rather than blank it while a login is attempted.
  useEffect(() => {
    if (hasHydrated && !needsBootstrap && !lostSession) silentDemoAttempted = true;
  }, [hasHydrated, needsBootstrap, lostSession]);

  useEffect(() => {
    if (!silentEligible || silent !== 'idle' || silentDemoAttempted) return;
    silentDemoAttempted = true;
    setSilent('running');
    void silentDemoLogin().then(() => setSilent('done'));
  }, [silentEligible, silent]);

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

  // Hold the screen (no modal flash) while the silent login is deciding.
  if (silentPending) return null;

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
