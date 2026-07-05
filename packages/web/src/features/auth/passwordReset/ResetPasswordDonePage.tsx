import { Link } from 'react-router';
import { AuthShell } from './AuthShell';

/**
 * Screen 4 — reset complete (issue 765). Confirms success and that other sessions were
 * signed out (the confirm endpoint blacklists every other refresh token; ADR-0209).
 */
export function ResetPasswordDonePage() {
  return (
    <AuthShell
      icon={<SuccessBadge />}
      title="You're all set"
      subtitle="Your password has been updated. For your security, we signed out your other sessions."
      backToSignIn={false}
    >
      <Link
        to="/login"
        className="
          h-11 w-full rounded bg-brand-primary text-white
          text-sm font-semibold flex items-center justify-center
          hover:bg-brand-primary-dark
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          transition-colors
        "
      >
        Continue to sign in
      </Link>
    </AuthShell>
  );
}

/** Circular green success check. */
function SuccessBadge() {
  return (
    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-semantic-on-track/15 text-semantic-on-track">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 12.5l4.5 4.5L19 7"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
