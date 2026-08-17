import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AuthShell } from './passwordReset/AuthShell';
import { bootstrapAccessToken } from '@/api/client';
import { queryClient } from '@/lib/queryClient';
import { CheckIcon } from '@/components/Icons';

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
 * ERROR_COPY must cover **every** code `services.OIDCError` can carry, plus the
 * view-level ones. Four backend codes fell through to the generic "Something went
 * wrong" for months (#2876) — including `email_unverified`, which is a policy
 * outcome whose generic copy told the user to "try again", something that could
 * never work.
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
  // The account exists and is a member — it has been switched off. Deliberately
  // distinct from sso_no_member: telling a deactivated member to ask for an invite
  // sends them down a path that cannot resolve it (#2875).
  sso_account_disabled: {
    title: 'Your account is deactivated',
    subtitle:
      'Your identity provider signed you in, but this TruePPM account has been deactivated, so sign-in was refused. Ask a workspace admin to reactivate it.',
    code: 'SSO_ACCOUNT_DISABLED',
  },
  // A *policy* outcome, not a fault. The generic copy told the user to "try again",
  // which can never work — the fix is at the identity provider (#2876).
  email_unverified: {
    title: 'Your email address is not verified',
    subtitle:
      'Your identity provider did not confirm that your email address is verified, and TruePPM requires a verified address before it will link an account. Verify your email with your provider, then sign in again.',
    code: 'SSO_EMAIL_UNVERIFIED',
  },
  // The state an operator lands in before setting TRUEPPM_EGRESS_ALLOWLISTED_HOSTS
  // for an in-cluster IdP. Naming the provider side is what makes it actionable.
  provider_unreachable: {
    title: "We couldn't reach your identity provider",
    subtitle:
      'TruePPM could not complete the exchange with your identity provider — it did not respond, or outbound access to it is blocked. This is a server-side configuration issue: ask an admin to check the provider with Test connection.',
    code: 'SSO_PROVIDER_UNREACHABLE',
  },
  invalid_id_token: {
    title: "We couldn't verify your identity provider's response",
    subtitle:
      'The identity token from your provider did not pass verification, so no session was created. Retrying is unlikely to help — ask an admin to check the provider configuration (issuer, client ID, and signing keys).',
    code: 'SSO_INVALID_ID_TOKEN',
  },
  token_exchange_failed: {
    title: 'Your identity provider declined the sign-in',
    subtitle:
      'Your provider refused to exchange the sign-in code — usually a client ID or client secret that no longer matches, or an expired code. Start again from the sign-in screen; if it keeps failing, ask an admin to check the provider credentials.',
    code: 'SSO_TOKEN_EXCHANGE_FAILED',
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

// Named SuccessBadge, not CheckIcon: this is the 44px circular badge *container*,
// distinct from the CheckIcon SVG it now holds (issue 1749).
const SuccessBadge = (
  <span
    aria-hidden="true"
    className="flex h-11 w-11 items-center justify-center rounded-full bg-semantic-on-track-bg text-semantic-on-track"
  >
    <CheckIcon className="h-6 w-6" />
  </span>
);

const WarnIcon = (
  <span
    aria-hidden="true"
    className="flex h-11 w-11 items-center justify-center rounded-full bg-semantic-critical-bg text-semantic-critical text-xl"
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
      icon={SuccessBadge}
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
