/**
 * Per-source freshness / reconnect line for the My Work external feed (#1422).
 *
 * Renders one subtle line per connected external source: a "Jira · synced 2 min
 * ago" freshness note, or — when the #1419 pull worker flipped the connection to
 * `auth_failed` (ADR-0097 §5) or `invalid_filter` (#2888) — an amber link so the
 * user knows their items may be stale and how to fix it. Amber (recoverable),
 * never red.
 *
 * Since #2925 the line also states when the feed above it is only the first N of
 * the user's assigned items. That belongs *here*, next to the list it qualifies,
 * rather than only on the settings page: the truncation is a fact about what the
 * user is currently reading, and a partial feed that says nothing is
 * indistinguishable from a complete one.
 */
import { Link } from 'react-router';
import type { MyWorkExternalSource } from '@/hooks/useMyWork';
import { formatRelative } from '@/lib/formatRelative';
import { syncFailureMessage, truncationNotice } from '@/features/integrations/syncOutcome';

const CONNECTED_ACCOUNTS_ROUTE = '/me/settings/connected-accounts';

interface Props {
  sources: MyWorkExternalSource[];
}

export function MyWorkSourceFreshness({ sources }: Props) {
  if (sources.length === 0) return null;

  return (
    <ul className="mt-2 flex flex-col gap-1 px-3 md:px-3">
      {sources.map((s) => {
        // Both states stop the pull and both are fixed on the same page, but
        // they are not the same fault: `invalid_filter` (#2888) means the saved
        // filter can no longer be scoped to the selected projects, and the token
        // is fine. Sending that user to "Reconnect" would have them re-issue a
        // working credential and see no change.
        const needsAuth = s.status === 'auth_failed';
        const needsFilterFix = s.status === 'invalid_filter';
        const healthy = !needsAuth && !needsFilterFix;
        // A pull can fail while the connection stays `connected` — an
        // unreachable host, a spent rate-limit budget. Those leave the feed
        // above showing the last-good cache, and without this the line reports
        // the *clock* ("synced 3h ago") on a sync that did not happen, which is
        // the same "reads identically whether it worked or not" defect #2925
        // exists to end — one surface down.
        const failed = healthy && s.last_sync && !s.last_sync.ok ? s.last_sync : null;
        // Only stated when the connection is otherwise healthy: a source that
        // needs reconnecting has a bigger problem than a partial page, and
        // stacking both would bury the one the user can act on.
        const truncated = healthy ? truncationNotice(s.last_sync) : null;
        return (
          <li
            key={s.source_type}
            className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-text-secondary"
          >
            <span className="font-medium">{s.label}</span>
            {needsAuth || needsFilterFix ? (
              <>
                <span aria-hidden="true">·</span>
                <Link
                  to={CONNECTED_ACCOUNTS_ROUTE}
                  className="font-medium text-semantic-at-risk hover:underline
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                    focus-visible:ring-offset-1 rounded-control"
                >
                  {needsAuth ? `Reconnect ${s.label}` : `Fix ${s.label} filter`}
                </Link>
              </>
            ) : failed ? (
              // Amber like the two states above (recoverable, never red), but no
              // link: neither remedy lives on Connected Accounts, so sending the
              // user there would be a dead trip.
              <span className="text-semantic-at-risk">
                <span aria-hidden="true">· </span>
                {syncFailureMessage(failed, s.label)}
              </span>
            ) : s.last_synced_at ? (
              <span>
                <span aria-hidden="true">· </span>synced{' '}
                {formatRelative(new Date(s.last_synced_at))}
              </span>
            ) : (
              <span>
                <span aria-hidden="true">· </span>not synced yet
              </span>
            )}
            {truncated ? (
              <span className="text-neutral-text-primary">
                <span aria-hidden="true">· </span>
                {truncated}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
