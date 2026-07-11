import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AuthShell } from './passwordReset/AuthShell';
import { bootstrapAccessToken } from '@/api/client';
import { queryClient } from '@/lib/queryClient';

/**
 * SSO completion landing — the SPA route the OIDC callback 302s to (issue 1392,
 * ADR-0187 §2). This is the terminal step of the sign-in flow (state 4/5).
 *
 * The callback never puts a token in the URL: on success it has already set the
 * hardened httpOnly refresh cookie and redirected here with no query. This page
 * then mints the in-memory access token from that cookie ({@link bootstrapAccessToken},
 * the same path used on a normal reload) and enters the app. On any failure the
 * callback redirects here with a non-sensitive `?error=<code>`; we render the
 * matching state — most importantly `sso_no_member`, the "verified at your IdP
 * but not a member of this workspace" case.
 *
 * Sits outside RequireAuth (a public route) because a not-yet-member arriving
 * with `sso_no_member` has no session — RequireAuth would bounce them to /login
 * and swallow the error before it could be shown.
 */

interface ErrorCopy {
  title: string;
  subtitle: string;
  /** The stable error code shown to the user for a support handoff. */
  code: string;
}

// Map the backend's non-sensitive error codes (services.OIDCError.code + the
// view-level codes) to human copy. Anything unrecognized falls back to generic —
// we never echo an arbitrary server string into the page.
const ERROR_COPY: Record<string, ErrorCopy> = {
  sso_no_member: {
    title: "You're verified, but not a member yet",
    subtitle:
      'Your identity provider signed you in, but your account is not a member of this workspace yet. Ask a workspace admin to invite you, then sign in again.',
    code: 'SSO_NO_MEMBER',
  },
  access_denied: {
    title: 'Sign-in was canceled',
    subtitle:
      'You canceled the request at your identity provider, or it declined to share your identity. You can try again.',
    code: 'SSO_ACCESS_DENIED',
  },
  invalid_state: {
    title: 'Sign-in could not be verified',
    subtitle:
      'This sign-in link could not be verified in your browser. Start again from the sign-in screen — do not reuse a bookmarked callback link.',
    code: 'SSO_INVALID_STATE',
  },
  invalid_request: {
    title: 'Sign-in could not be verified',
    subtitle: 'The response from your identity provider was incomplete. Please try again.',
    code: 'SSO_INVALID_REQUEST',
  },
  sso_not_configured: {
    title: 'SSO is not configured',
    subtitle:
      'Single sign-on is not set up for this workspace. Sign in with your email and password, or ask an admin to configure SSO.',
    code: 'SSO_NOT_CONFIGURED',
  },
};

const GENERIC_ERROR: ErrorCopy = {
  title: "We couldn't complete sign-in",
  subtitle:
    'Something went wrong while verifying your identity. Please try again, or sign in with your password.',
  code: 'SSO_ERROR',
};

function copyFor(code: string | null): ErrorCopy {
  if (!code) return GENERIC_ERROR;
  return ERROR_COPY[code] ?? { ...GENERIC_ERROR, code: `SSO_${code.toUpperCase()}` };
}

const CheckIcon = (
  <span
    aria-hidden="true"
    className="flex h-11 w-11 items-center justify-center rounded-full bg-semantic-on-track-bg text-semantic-on-track-text text-xl"
  >
    ✓
  </span>
);

const WarnIcon = (
  <span
    aria-hidden="true"
    className="flex h-11 w-11 items-center justify-center rounded-full bg-semantic-critical-bg text-semantic-critical-text text-xl"
  >
    !
  </span>
);

export function SsoCompletePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const error = searchParams.get('error');

  // On the success path the bootstrap can itself fail (e.g. the refresh cookie
  // did not arrive) — track that so we show an error rather than an eternal spinner.
  const [bootstrapFailed, setBootstrapFailed] = useState(false);

  useEffect(() => {
    if (error) return; // error states are rendered, not bootstrapped
    let cancelled = false;
    void (async () => {
      const ok = await bootstrapAccessToken();
      if (cancelled) return;
      if (ok) {
        // Clear any stale unauthenticated cache, then defer to RootRedirect,
        // which resolves the server-decided landing (ADR-0129) once `me` loads.
        queryClient.clear();
        void navigate('/', { replace: true });
      } else {
        setBootstrapFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [error, navigate]);

  if (error || bootstrapFailed) {
    const c = error ? copyFor(error) : GENERIC_ERROR;
    return (
      <AuthShell icon={WarnIcon} title={c.title} subtitle={c.subtitle}>
        <p className="self-center text-xs text-neutral-text-secondary" data-testid="sso-error-code">
          Error code: <span className="tppm-mono">{c.code}</span>
        </p>
      </AuthShell>
    );
  }

  // Success in progress (flow state 4): the cookie is set, we are minting the
  // session. This view is brief before the redirect into the app.
  return (
    <AuthShell
      icon={CheckIcon}
      title="Identity verified"
      subtitle="Completing sign-in and loading your workspace…"
      backToSignIn={false}
    >
      <div
        className="self-center h-5 w-5 rounded-full border-2 border-neutral-border border-t-brand-primary motion-safe:animate-spin"
        role="status"
        aria-label="Completing sign-in"
      />
    </AuthShell>
  );
}
