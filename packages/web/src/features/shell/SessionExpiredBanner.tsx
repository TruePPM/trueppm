import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router';
import { useAuthStore } from '@/stores/authStore';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { WarningIcon } from '@/components/Icons';

/**
 * Build the `/login` destination carrying the current location as `?next=`, so
 * re-authenticating returns the user to where they were interrupted rather than
 * their default landing surface (#2052). Mirrors the encoding `RequireAuth` uses
 * for the unauthenticated redirect (`encodeURIComponent(pathname + search)`),
 * which `LoginPage` already honors on successful sign-in.
 */
function loginHrefWithNext(location: Location): string {
  const next = encodeURIComponent(location.pathname + location.search);
  return `/login?next=${next}`;
}

/**
 * Blocking re-auth gate shown when the user's session expires (#352, escape
 * hatch #1922). Renders nothing while `sessionExpired === false` or while the
 * user has already escaped into read-only mode (`sessionExpiredReadOnly ===
 * true` — see `SessionExpiredReadOnlyBar` below, which takes over at that
 * point). Otherwise renders a fixed-position, focus-trapped dialog that:
 *   - explains what happened in plain language;
 *   - offers a primary "Sign in" action that navigates to `/login`;
 *   - offers a secondary "Continue viewing (read-only)" escape hatch that
 *     releases the trap and hands off to the persistent banner instead of
 *     leaving the user with no way to even look at cached content (#1922);
 *   - traps focus so a user mid-edit doesn't silently keep typing into the
 *     stale UI behind the modal.
 *
 * Mounted once in `AppShell`, fixed over the whole viewport — it must stay
 * outside the normal document flow so it can cover everything, including the
 * TopBar, while it's the active state.
 *
 * The component does not auto-redirect. The previous `auth:sessionExpired`
 * handler in `AppShell` did, which left users on the login screen with no
 * idea why — the most insidious failure mode in #352. Forcing the user to
 * click an explicit action makes the cause visible and gives them a chance
 * to copy unsaved input out of an open editor before navigating away.
 */
export function SessionExpiredBanner() {
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const readOnly = useAuthStore((s) => s.sessionExpiredReadOnly);
  const enterReadOnlyMode = useAuthStore((s) => s.enterReadOnlyMode);
  const clearTokens = useAuthStore((s) => s.clearTokens);
  const navigate = useNavigate();
  const location = useLocation();

  const modalActive = sessionExpired && !readOnly;
  // Contain Tab/Shift+Tab inside the modal and land focus on the Sign in
  // action on open (WCAG 2.4.3 / 2.1.2). No onEscape is passed: Escape must
  // NOT dismiss the modal — that's what the explicit "Continue viewing
  // (read-only)" action is for, so leaving read-only mode is always a
  // deliberate click, not a reflexive keypress.
  const trapRef = useFocusTrap<HTMLDivElement>(modalActive);

  if (!modalActive) return null;

  function handleSignIn() {
    // Capture the destination BEFORE clearTokens — clearing tokens can trigger a
    // redirect that changes location, and we want the screen the user was on.
    const dest = loginHrefWithNext(location);
    // clearTokens also clears sessionExpired/sessionExpiredReadOnly — without
    // this the modal would remain visible while the login screen renders.
    clearTokens();
    void navigate(dest, { replace: true });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
      aria-describedby="session-expired-body"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-overlay motion-safe:animate-scrim-fade"
    >
      <div
        ref={trapRef}
        tabIndex={-1}
        className="bg-neutral-surface border border-neutral-border rounded-card w-[420px] max-w-[90vw] p-5 focus:outline-none motion-safe:animate-modal-scale-in"
      >
        <h2
          id="session-expired-title"
          className="text-base font-semibold text-neutral-text-primary m-0 mb-2"
        >
          Your session expired
        </h2>
        <p id="session-expired-body" className="text-sm text-neutral-text-secondary m-0 mb-5">
          For your security, you&apos;ve been signed out. Recent unsaved edits may not have been
          saved. Sign in again to continue, or keep viewing the read-only content already loaded in
          this tab.
        </p>
        <div className="flex justify-end gap-2">
          {/* Touch targets clear the 44px min on mobile (rule 5, where touch is
              primary) and relax to the compact desktop height at md+, matching the
              shell's RoleContextMenuRow pattern. */}
          <button
            type="button"
            onClick={handleSignIn}
            className="h-9 min-h-[44px] md:min-h-0 px-4 rounded-control bg-brand-primary text-white text-sm font-medium border-none hover:bg-brand-primary-dark focus:ring-2 focus:ring-white focus:ring-offset-1 focus:ring-offset-brand-primary focus:outline-none"
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={enterReadOnlyMode}
            className="h-9 min-h-[44px] md:min-h-0 px-4 rounded-control bg-transparent text-neutral-text-primary text-sm font-medium border border-neutral-border hover:bg-neutral-surface-raised focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none"
          >
            Continue viewing (read-only)
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Slim, non-blocking, in-flow banner that replaces `SessionExpiredBanner`'s
 * modal once the user picks "Continue viewing (read-only)" (#1922). Mounted
 * in `AppShell`'s normal document flow alongside `OfflineBanner` — not
 * `fixed` — so it never covers the TopBar and always occupies the same
 * always-visible header region above the scrollable content, regardless of
 * scroll position (WCAG 4.1.3 status messages).
 *
 * Reads are already served from the TanStack Query cache (no new authenticated
 * fetches are attempted: the apiClient request interceptor short-circuits
 * every request, read or write, while `sessionExpired` is true). Writes are
 * blocked the same way; the query client's global mutation `onError` (see
 * lib/queryClient) re-engages the blocking modal the instant a write is
 * attempted, so a stray mutation can't fail silently or loop.
 */
export function SessionExpiredReadOnlyBar() {
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const readOnly = useAuthStore((s) => s.sessionExpiredReadOnly);
  const clearTokens = useAuthStore((s) => s.clearTokens);
  const navigate = useNavigate();
  const location = useLocation();
  const signInRef = useRef<HTMLButtonElement>(null);

  const active = sessionExpired && readOnly;

  // Re-seat focus on this banner's "Sign in again" action the moment we drop
  // out of the trapped modal into read-only mode (WCAG 2.4.3). The focus
  // trap's own cleanup restores focus to whatever was focused *before* the
  // modal opened, which could be anywhere in the stale UI behind it — not
  // this banner, which is the only remaining path back to a real session.
  useEffect(() => {
    if (active) signInRef.current?.focus();
  }, [active]);

  if (!active) return null;

  function handleSignIn() {
    const dest = loginHrefWithNext(location);
    clearTokens();
    void navigate(dest, { replace: true });
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Session expired — viewing read-only"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-semantic-at-risk bg-semantic-at-risk-bg px-4 py-1.5"
    >
      <p className="flex items-center gap-2 text-xs font-medium text-semantic-at-risk m-0">
        {/* Amber "degraded — writes deferred" vocabulary shared with OfflineBanner
            and SyncStatusBadge (web-rule 226); the glyph is decorative, the text
            carries the announcement (rule 6 — color is never the only signal). */}
        <WarningIcon
          className="inline-block h-3 w-3 shrink-0 align-[-0.125em]"
          aria-hidden="true"
        />
        Your session expired. You&apos;re viewing cached content read-only — changes won&apos;t save
        until you sign in again.
      </p>
      {/* 44px min touch target on mobile (rule 5) — this is the sole recovery
          affordance in read-only mode and the bar is mounted at every
          breakpoint — relaxing to the slim h-7 banner height at md+. */}
      <button
        ref={signInRef}
        type="button"
        onClick={handleSignIn}
        className="h-7 min-h-[44px] md:min-h-0 shrink-0 rounded-control bg-brand-primary px-3 text-xs font-medium text-white border-none hover:bg-brand-primary-dark focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        Sign in again
      </button>
    </div>
  );
}
