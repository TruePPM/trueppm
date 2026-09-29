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
 * Operator-only: `/health/system/` is `IsWorkspaceOperator`-gated (Django
 * superuser only, #4009) — a Project Admin or workspace Admin is NOT enough and
 * gets a 403. The fetch is therefore gated on `is_workspace_operator`
 * (`enabled: false` skips the request entirely), not the broader
 * `can_access_admin_settings` (Admin+ in any project OR workspace) that used to
 * gate it here and produced a guaranteed 403 on every page load for any Project
 * Admin (#4219). Anonymous / non-operator users never see the banner.
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
  const isOperator = user?.is_workspace_operator === true;
  const { data } = useSystemHealth({ poll: false, enabled: isOperator });
  // Gate on isOperator as well as the payload (defense-in-depth): the fetch is
  // already skipped for non-operators, but never render the notice unless we
  // have confirmed operator — a non-operator must never see this operator status.
  const disabled = isOperator && data?.security?.rate_limiting_enabled === false;

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
