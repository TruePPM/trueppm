import { Link } from 'react-router';
import { AuthShell } from './AuthShell';

/**
 * Screen 5 — expired / invalid link (issue 765). Reached when the confirm endpoint
 * returns `code: invalid_token` (bad, unknown, or >30-min-old token; ADR-0209).
 */
export function ResetPasswordExpiredPage() {
  return (
    <AuthShell
      icon={<WarningBadge />}
      title="This link has expired"
      subtitle="Password reset links are valid for 30 minutes. Request a new one to continue."
    >
      <Link
        to="/forgot-password"
        className="
          h-11 w-full rounded bg-brand-primary text-neutral-text-inverse
          text-sm font-semibold flex items-center justify-center
          hover:bg-brand-primary-dark
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          transition-colors
        "
      >
        Request a new link
      </Link>
    </AuthShell>
  );
}

/** Circular amber warning badge. */
function WarningBadge() {
  return (
    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-semantic-at-risk/15 text-semantic-at-risk">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3l9 16H3l9-16z"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinejoin="round"
        />
        <path d="M12 10v4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        <circle cx="12" cy="16.5" r="1" fill="currentColor" />
      </svg>
    </span>
  );
}
