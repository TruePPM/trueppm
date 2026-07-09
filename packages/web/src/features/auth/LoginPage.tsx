import { useState, useId, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import axios from 'axios';
import { useAuthStore } from '@/stores/authStore';
import { queryClient } from '@/lib/queryClient';
import type { CurrentUser } from '@/hooks/useCurrentUser';
import { safeLandingPath } from '@/features/me/landing';
import { LogoMark } from '@/components/Icons';

interface TokenResponse {
  // The refresh token is no longer returned in the body — it is set as an
  // httpOnly, Secure, SameSite=Strict cookie by the login endpoint (#897).
  access: string;
}

/**
 * Post-login destination. A safe `next` deep link always wins (the captured
 * route the user was trying to reach), with a project `/board` route folded to
 * Overview — the common "logged out from board, log back in" case. Other deep
 * links (risk, schedule, sprints, resources, etc.) pass through untouched so
 * shared URLs still work after a re-auth.
 *
 * When there is no safe `next`, defer to the server-resolved app front door
 * (ADR-0129) — `me.landing.path`, guarded by the same allowlist — instead
 * of the bare root. This means a contributor lands on My Work, a PM on a project
 * Overview, etc. directly, rather than bouncing through `/`'s RootRedirect.
 *
 * `next` is attacker-controllable via the query string, so it is validated as
 * a same-origin relative path before use to prevent an open redirect (#899):
 * anything not starting with a single `/`, any protocol-relative (`//`) or
 * backslash-smuggled (`/\`) value, and anything that resolves off-origin falls
 * through to the landing path (then `/` if that is also unavailable).
 */
export function loginRedirectDest(next: string, landingPath?: string): string {
  const fallback = landingPath ? safeLandingPath(landingPath) : '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  try {
    const u = new URL(next, window.location.origin);
    if (u.origin !== window.location.origin) return fallback;
  } catch {
    return fallback;
  }
  return next.replace(/^(\/projects\/[^/]+)\/board(\/.*)?$/, '$1/overview');
}

// Decorative mini-Gantt rows for the marketing panel.
const GANTT_ROWS = [
  { label: 'Engine integration', widthPct: 70, offsetPct: 10, variant: 'critical' as const },
  { label: 'Telemetry firmware', widthPct: 55, offsetPct: 18, variant: 'at-risk' as const },
  { label: 'Avionics PCBA', widthPct: 65, offsetPct: 25, variant: 'on-track' as const },
  { label: 'FAT review', widthPct: 4, offsetPct: 70, variant: 'milestone' as const },
] as const;

const MONTH_LABELS = ['MAY', 'JUN', 'JUL', 'AUG'];

const BAR_COLOR: Record<(typeof GANTT_ROWS)[number]['variant'], string> = {
  critical: 'bg-semantic-critical',
  'at-risk': 'bg-semantic-at-risk',
  'on-track': 'bg-semantic-on-track',
  milestone: '',
};

/**
 * Decorative static mini-Gantt used in the marketing panel.
 * The entire element is aria-hidden — it conveys no functional information.
 */
function MiniGantt() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {GANTT_ROWS.map((row) => (
        <div key={row.label} className="flex items-center gap-3 h-5">
          <span className="text-xs text-chrome-text-secondary w-36 shrink-0 truncate">
            {row.label}
          </span>
          <div className="relative flex-1 h-4">
            {row.variant === 'milestone' ? (
              <div
                className="absolute top-0 h-4 w-4 flex items-center justify-center"
                style={{ left: `${row.offsetPct}%`, transform: 'translateX(-50%)' }}
              >
                {/* Milestone diamond */}
                <div className="w-3 h-3 rotate-45" style={{ backgroundColor: '#FCD34D' }} />
              </div>
            ) : (
              <div
                className={`absolute top-0 h-full rounded-chip ${BAR_COLOR[row.variant]} opacity-80`}
                style={{ left: `${row.offsetPct}%`, width: `${row.widthPct}%` }}
              />
            )}
          </div>
        </div>
      ))}

      {/* Month axis */}
      <div className="flex mt-1" aria-hidden="true">
        {/* Spacer matching label width */}
        <div className="w-36 shrink-0" />
        <div className="flex-1 flex justify-between">
          {MONTH_LABELS.map((m) => (
            <span key={m} className="tppm-mono text-xs text-chrome-text-secondary">
              {m}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSsoTooltip, setShowSsoTooltip] = useState(false);

  const emailId = useId();
  const passwordId = useId();
  const rememberMeId = useId();

  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await axios.post<TokenResponse>('/api/v1/auth/token/', {
        username: email,
        password,
        remember_me: rememberMe,
      });
      setAccessToken(response.data.access);
      queryClient.clear();

      // Resolve the server-decided front door (ADR-0129) for the no-`next` case.
      // Use bare axios with the just-minted access token (apiClient's interceptor
      // hasn't observed the new token yet, and importing apiClient here would
      // couple login to its module init). A network hiccup must not block
      // sign-in — fall back to bare `/`, whose RootRedirect resolves the same
      // landing once `me` is fetched into the cache.
      let landingPath: string | undefined;
      try {
        const me = await axios.get<CurrentUser>('/api/v1/auth/me/', {
          headers: { Authorization: `Bearer ${response.data.access}` },
        });
        queryClient.setQueryData(['current-user'], me.data);
        landingPath = me.data.landing?.path;
      } catch {
        /* offline / slow — RootRedirect resolves the landing after navigation */
      }

      const next = searchParams.get('next') ?? '';
      void navigate(loginRedirectDest(next, landingPath), { replace: true });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        setError('Invalid email or password.');
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const canSubmit = email.trim() !== '' && password !== '' && !isSubmitting;

  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-2 bg-neutral-surface">
      {/* ── Left column: form ── */}
      <div className="flex flex-col justify-center px-10 py-16 md:px-20 gap-8">
        {/* Brand — duotone mark + two-color wordmark (brand v1.0, ADR-0103) */}
        <div className="flex items-center gap-2.5" aria-label="TruePPM">
          <LogoMark size={36} className="flex-shrink-0" />
          <span className="font-display text-2xl font-bold tracking-[-0.02em] leading-none">
            <span className="text-navy-700 dark:text-reversed">True</span>
            <span className="text-brand-primary">PPM</span>
          </span>
        </div>

        {/* Hero copy */}
        <div className="flex flex-col gap-1">
          <h1 className="text-[32px] font-semibold text-neutral-text-primary tracking-tight leading-tight">
            Welcome back
          </h1>
          <p className="text-sm text-neutral-text-secondary leading-relaxed">
            Sign in to keep your launch on schedule.
          </p>
        </div>

        {/* Form */}
        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          {/* Email */}
          <div className="flex flex-col gap-1">
            <label htmlFor={emailId} className="text-sm font-medium text-neutral-text-primary">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isSubmitting}
              placeholder="anna.khoury@example.com"
              className="
                h-10 px-3 rounded border border-neutral-border
                bg-neutral-surface text-neutral-text-primary text-sm
                placeholder:text-neutral-text-secondary
                focus-visible:outline-none focus-visible:border-brand-primary
                focus-visible:ring-[3px] focus-visible:ring-brand-primary/20
                disabled:opacity-50 disabled:cursor-not-allowed
              "
            />
          </div>

          {/* Password — Forgot? link sits below the input so the keyboard tab
              order goes Email → Password → checkbox → Sign in without a detour
              through the recovery link in the middle of the credentials. */}
          <div className="flex flex-col gap-1">
            <label htmlFor={passwordId} className="text-sm font-medium text-neutral-text-primary">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSubmitting}
              className="
                h-10 px-3 rounded border border-neutral-border
                bg-neutral-surface text-neutral-text-primary text-sm font-mono
                focus-visible:outline-none focus-visible:border-brand-primary
                focus-visible:ring-[3px] focus-visible:ring-brand-primary/20
                disabled:opacity-50 disabled:cursor-not-allowed
              "
            />
            <div className="flex justify-end">
              {/* Self-service password reset (issue 765). Links to the public
                  /forgot-password flow; sits below the password input so the
                  keyboard tab order stays Email → Password → Forgot? → Keep me
                  signed in → Sign in without a detour through the recovery link in
                  the middle of the credentials. */}
              <Link
                to="/forgot-password"
                aria-label="Forgot password?"
                className="text-xs font-medium text-brand-primary hover:text-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
              >
                Forgot?
              </Link>
            </div>
          </div>

          {/* Remember me */}
          <div className="flex items-center gap-2">
            <div className="relative flex items-center justify-center w-4 h-4 shrink-0">
              <input
                id={rememberMeId}
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="
                  w-4 h-4 rounded-chip border border-neutral-border
                  bg-neutral-surface text-brand-primary
                  checked:bg-brand-primary checked:border-brand-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                  cursor-pointer
                "
              />
            </div>
            <label
              htmlFor={rememberMeId}
              className="text-xs text-neutral-text-secondary cursor-pointer select-none"
            >
              Keep me signed in for 30 days
            </label>
          </div>

          {/* Error */}
          {error !== null && (
            <p role="alert" className="text-sm text-semantic-critical">
              {error}
            </p>
          )}

          {/* Sign in button */}
          <button
            type="submit"
            disabled={!canSubmit}
            className="
              h-11 w-full rounded bg-brand-primary text-white
              text-sm font-semibold
              hover:bg-brand-primary-dark
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              disabled:opacity-50 disabled:cursor-not-allowed
              transition-colors
            "
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>

          {/* OR divider */}
          <div className="flex items-center gap-3" aria-hidden="true">
            <div className="flex-1 h-px bg-neutral-border" />
            <span className="text-xs text-neutral-text-secondary">OR</span>
            <div className="flex-1 h-px bg-neutral-border" />
          </div>

          {/* SSO button — stub until basic OIDC login lands (issue 1392);
              enterprise may still override this component's slot */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSsoTooltip((v) => !v)}
              onBlur={() => setShowSsoTooltip(false)}
              aria-expanded={showSsoTooltip}
              className="
                h-11 w-full rounded border border-neutral-border
                bg-neutral-surface-raised text-neutral-text-primary
                text-sm font-medium
                hover:bg-neutral-surface-sunken
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                transition-colors
              "
            >
              Continue with SSO
            </button>
            {showSsoTooltip && (
              <div
                role="tooltip"
                className="
                  absolute top-full left-1/2 -translate-x-1/2 mt-2 z-10 w-64
                  bg-neutral-text-primary text-neutral-text-inverse text-xs rounded px-3 py-2
                  whitespace-normal shadow-none border border-neutral-border
                "
              >
                Single sign-on with your identity provider is coming — tracked in issue 1392.
                <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-neutral-text-primary rotate-45 border-l border-t border-neutral-border" />
              </div>
            )}
          </div>
        </form>

        {/* Footer: TruePPM is self-hosted and invite-based, so there is no
            self-service signup. Direct the user to their admin rather than to a
            nonexistent /signup route. Team invites are tracked in issue 1410. */}
        <p className="text-xs text-neutral-text-secondary w-fit">
          Need access? Ask your workspace admin to invite you.
        </p>
      </div>

      {/* ── Right column: marketing panel ── */}
      <div className="hidden md:flex flex-col justify-between bg-chrome-surface relative overflow-hidden px-16 py-16">
        {/* Decorative grid overlay */}
        <svg
          aria-hidden="true"
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ opacity: 0.35 }}
        >
          <defs>
            <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path
                d="M 32 0 L 0 0 0 32"
                fill="none"
                stroke="currentColor"
                strokeWidth="0.5"
                className="text-chrome-text-secondary"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>

        {/* Content */}
        <div className="relative flex flex-col gap-8">
          {/* Status pill */}
          <div className="inline-flex items-center gap-2 self-start">
            <div
              className="px-3 py-1 rounded-full text-xs font-semibold tracking-widest uppercase"
              style={{ backgroundColor: 'rgba(102, 185, 152, 0.14)', color: '#66B998' }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
                style={{ backgroundColor: '#66B998' }}
                aria-hidden="true"
              />
              CPM v{__APP_VERSION__} live
            </div>
          </div>

          {/* Headline */}
          <div className="flex flex-col gap-3">
            <h2 className="text-[28px] font-semibold text-chrome-text-primary leading-snug tracking-tight max-w-sm">
              Schedules that hold under pressure.
            </h2>
            <p className="text-sm text-chrome-text-secondary leading-relaxed max-w-sm">
              Critical-path scheduling, three-point estimates, and Monte Carlo forecasting — built
              for teams that ship to a launch window.
            </p>
          </div>

          {/* Mini Gantt */}
          <MiniGantt />
        </div>

        {/* Panel footer */}
        <p className="relative tppm-mono text-xs text-chrome-text-secondary">
          v{__APP_VERSION__} · build {__BUILD_SHA__} · status: operational
        </p>
      </div>
    </div>
  );
}
