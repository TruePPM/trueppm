import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AuthShell } from './AuthShell';
import { isRateLimited, redactEmail, requestPasswordReset } from './resetApi';

/**
 * Screen 2 — "check your email" (issue 765). Confirms a redacted address, states the
 * 30-minute expiry, and offers a Resend that re-POSTs the same request (identical
 * idempotency to the initial send). The address arrives via router state from
 * Screen 1 — never the URL — so it is never bookmarkable or logged.
 */
export function ForgotPasswordSentPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const email = (location.state as { email?: string } | null)?.email ?? '';

  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [resendError, setResendError] = useState<string | null>(null);

  async function handleResend() {
    // No address in state (deep link / refresh) → send the user back to re-enter it.
    if (!email) {
      void navigate('/forgot-password');
      return;
    }
    setResendState('sending');
    setResendError(null);
    try {
      await requestPasswordReset(email);
      setResendState('sent');
    } catch (err: unknown) {
      setResendState('error');
      setResendError(
        isRateLimited(err)
          ? 'Too many attempts. Please wait a minute and try again.'
          : 'Could not resend the link. Please try again.',
      );
    }
  }

  return (
    <AuthShell
      step={2}
      icon={<MailBadge />}
      title="Check your email"
      subtitle={
        email ? (
          <>
            We sent a password reset link to <span className="font-medium">{redactEmail(email)}</span>
            .
          </>
        ) : (
          'We sent you a password reset link if an account exists for that address.'
        )
      }
    >
      <div className="flex flex-col gap-4">
        <div
          className="rounded-lg border border-neutral-border bg-neutral-surface-raised px-3.5 py-3 text-xs text-neutral-text-secondary leading-relaxed"
          role="note"
        >
          The link is valid for <span className="font-medium text-neutral-text-primary">30 minutes</span>.
          If it expires, you can request a new one.
        </div>

        <a
          href="mailto:"
          className="
            h-11 w-full rounded bg-brand-primary text-neutral-text-inverse
            text-sm font-semibold flex items-center justify-center
            hover:bg-brand-primary-dark
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
            transition-colors
          "
        >
          Open email app
        </a>

        <p className="text-xs text-neutral-text-secondary text-center">
          Didn’t get it?{' '}
          {resendState === 'sent' ? (
            <span className="font-medium text-semantic-on-track">Sent — check your inbox.</span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  void handleResend();
                }}
                disabled={resendState === 'sending'}
                className="font-medium text-brand-primary hover:text-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded disabled:opacity-50"
              >
                {resendState === 'sending' ? 'Resending…' : 'Resend'}
              </button>{' '}
              · check your spam folder
            </>
          )}
        </p>

        {resendError !== null && (
          <p role="alert" className="text-xs text-semantic-critical text-center">
            {resendError}
          </p>
        )}
      </div>
    </AuthShell>
  );
}

/** Circular mail badge — rule-143 sage fill + navy glyph, AA on any surface (#1705). */
function MailBadge() {
  return (
    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-primary/15 text-neutral-text-primary">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect
          x="3"
          y="5"
          width="18"
          height="14"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.75"
        />
        <path d="M4 7l8 5 8-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    </span>
  );
}
