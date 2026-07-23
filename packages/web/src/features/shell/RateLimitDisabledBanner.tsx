import { WarningIcon } from '@/components/Icons';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSystemHealth } from '@/hooks/useSystemHealth';

/**
 * Operator "API rate limiting disabled" banner (#2316, ADR-0604).
 *
 * Read-only status. GET /health/system/ reports `security.rate_limiting_enabled`,
 * which is `false` only when an operator has switched OFF all API throttling via
 * the TRUEPPM_RATE_LIMIT_ENABLED env var. With throttling off the API has no
 * abuse / denial-of-service protection, so admins get a persistent critical
 * banner. This is NOT a control — re-enabling it is an operator/env change, so
 * there is deliberately no link to change it here.
 *
 * Admin-only: the health endpoint 403s for non-admins, so the fetch is gated on
 * `can_access_admin_settings` (`enabled: false` skips the request entirely) and
 * anonymous / non-admin users never see the banner.
 *
 * Like OfflineBanner, the live region is mounted permanently and collapses to
 * `sr-only` when inactive so the message is injected into an already-present node
 * — a region mounted at the same instant as its content is not reliably announced
 * (#2203). Tri-state gating: only a strict `=== false` shows it, so it never
 * flash-shows while the health query is loading, and a stale payload with no
 * `security` block reads as "not disabled" rather than a false alarm.
 */
export function RateLimitDisabledBanner() {
  const { user } = useCurrentUser();
  const isAdmin = user?.can_access_admin_settings === true;
  const { data } = useSystemHealth({ poll: false, enabled: isAdmin });
  // Gate on isAdmin as well as the payload (defense-in-depth): the fetch is
  // already skipped for non-admins, but never render the notice unless we have
  // confirmed admin — a non-admin must never see this operator status.
  const disabled = isAdmin && data?.security?.rate_limiting_enabled === false;

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        disabled
          ? 'flex items-center justify-center gap-2 border-b border-semantic-critical bg-semantic-critical-bg px-4 py-1.5 text-xs font-medium text-semantic-critical'
          : 'sr-only'
      }
    >
      {disabled && (
        <>
          <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
          API rate limiting is disabled on this server — abuse and denial-of-service protection is
          off. Set TRUEPPM_RATE_LIMIT_ENABLED=true in the server environment to re-enable it.
        </>
      )}
    </div>
  );
}
