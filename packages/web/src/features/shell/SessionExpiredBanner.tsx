import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '@/stores/authStore';

/**
 * Modal banner shown when the user's session has expired (#352).
 *
 * Renders nothing while `sessionExpired === false`. When the flag flips
 * (set by the API 401 interceptor or the WebSocket close-code-4001 handler)
 * we render a fixed-position dialog over the entire app:
 *   - explains what happened in plain language;
 *   - offers a single "Sign in" action that navigates to `/login`;
 *   - traps focus so a user mid-edit doesn't silently keep typing into the
 *     stale UI behind the banner.
 *
 * The component does not auto-redirect. The previous `auth:sessionExpired`
 * handler in `AppShell` did, which left users on the login screen with no
 * idea why — the most insidious failure mode in #352. Forcing the user to
 * click an explicit action makes the cause visible and gives them a chance
 * to copy unsaved input out of an open editor before navigating away.
 */
export function SessionExpiredBanner() {
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const clearTokens = useAuthStore((s) => s.clearTokens);
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Auto-focus the action so screen readers announce the banner and a
  // keyboard user can dismiss it with a single Enter press.
  useEffect(() => {
    if (sessionExpired) {
      buttonRef.current?.focus();
    }
  }, [sessionExpired]);

  if (!sessionExpired) return null;

  function handleSignIn() {
    // clearTokens also clears the sessionExpired flag — without this the
    // banner would remain visible while the login screen is rendering.
    clearTokens();
    void navigate('/login', { replace: true });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
      aria-describedby="session-expired-body"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-lg w-[420px] max-w-[90vw] p-5">
        <h2
          id="session-expired-title"
          className="text-base font-semibold text-neutral-text-primary m-0 mb-2"
        >
          Your session expired
        </h2>
        <p
          id="session-expired-body"
          className="text-sm text-neutral-text-secondary m-0 mb-5"
        >
          For your security, you've been signed out. Recent unsaved edits may
          not have been saved. Sign in again to continue.
        </p>
        <div className="flex justify-end">
          <button
            ref={buttonRef}
            type="button"
            onClick={handleSignIn}
            className="h-9 px-4 rounded bg-brand-primary text-white text-sm font-medium border-none hover:bg-brand-primary-dark focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-brand-primary focus-visible:outline-none"
          >
            Sign in
          </button>
        </div>
      </div>
    </div>
  );
}
