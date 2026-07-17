import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { AuthShell } from './AuthShell';
import { isRateLimited, requestPasswordReset } from './resetApi';

/**
 * Screen 1 — request a reset link (issue 765, ADR-0209).
 *
 * The endpoint always returns 200 (no user enumeration), so on a resolved request
 * we always advance to the "sent" screen — we never reveal whether the address had
 * an account. The SSO hint is a STATIC informational banner (never driven by a
 * per-account lookup, which would itself leak account existence).
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const emailId = useId();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await requestPasswordReset(email.trim());
      // Carry the address to the confirmation screen (redacted there) via router
      // state — it is never placed in the URL.
      void navigate('/forgot-password/sent', { replace: true, state: { email: email.trim() } });
    } catch (err: unknown) {
      setError(
        isRateLimited(err)
          ? 'Too many attempts. Please wait a minute and try again.'
          : 'Something went wrong sending your reset link. Please try again.',
      );
      setIsSubmitting(false);
    }
  }

  const canSubmit = email.trim() !== '' && !isSubmitting;

  return (
    <AuthShell
      step={1}
      title="Reset your password"
      subtitle="Enter your work email and we'll send you a link to choose a new password."
    >
      {/* Static SSO hint — never a per-account signal (ADR-0209). */}
      <div
        className="flex gap-2.5 rounded-lg border border-neutral-border bg-neutral-surface-raised px-3.5 py-3 text-xs text-neutral-text-secondary leading-relaxed"
        role="note"
      >
        <span aria-hidden="true" className="mt-0.5 text-brand-primary">
          <InfoIcon />
        </span>
        <span>
          If your account uses single sign-on, you’ll be guided to your provider instead —
          resetting a password here won’t affect SSO sign-in.
        </span>
      </div>

      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        noValidate
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={emailId} className="text-sm font-medium text-neutral-text-primary">
            Work email
          </label>
          <input
            id={emailId}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isSubmitting}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- single-purpose recovery screen: focus its only input on open
            autoFocus
            placeholder="you@company.com"
            className="
              h-10 px-3 rounded border border-neutral-border
              bg-neutral-surface text-neutral-text-primary text-sm
              placeholder:text-neutral-text-disabled
              focus-visible:outline-none focus-visible:border-brand-primary
              focus-visible:ring-[3px] focus-visible:ring-brand-primary/20
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          />
        </div>

        {error !== null && (
          <p role="alert" className="text-sm text-semantic-critical">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="
            h-11 w-full rounded bg-brand-primary text-neutral-text-inverse
            text-sm font-semibold
            hover:bg-brand-primary-dark
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
            disabled:opacity-50 disabled:cursor-not-allowed
            transition-colors
          "
        >
          {isSubmitting ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
    </AuthShell>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 5a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM7.25 7.25h1.5v4.25h-1.5z" />
    </svg>
  );
}
