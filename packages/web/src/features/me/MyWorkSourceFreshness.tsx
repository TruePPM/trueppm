/**
 * Per-source freshness / reconnect line for the My Work external feed (#1422).
 *
 * Renders one subtle line per connected external source: a "Jira · synced 2 min
 * ago" freshness note, or — when the #1419 pull worker flipped the connection to
 * `auth_failed` (ADR-0097 §5) or `invalid_filter` (#2888) — an amber link so the
 * user knows their items may be stale and how to fix it. Amber (recoverable),
 * never red.
 */
import { Link } from 'react-router';
import type { MyWorkExternalSource } from '@/hooks/useMyWork';
import { formatRelative } from '@/lib/formatRelative';

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
        return (
          <li
            key={s.source_type}
            className="flex items-center gap-1.5 text-xs text-neutral-text-secondary"
          >
            <span className="font-medium">{s.label}</span>
            <span aria-hidden="true">·</span>
            {needsAuth || needsFilterFix ? (
              <Link
                to={CONNECTED_ACCOUNTS_ROUTE}
                className="font-medium text-semantic-at-risk hover:underline
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                  focus-visible:ring-offset-1 rounded-control"
              >
                {needsAuth ? `Reconnect ${s.label}` : `Fix ${s.label} filter`}
              </Link>
            ) : s.last_synced_at ? (
              <span>synced {formatRelative(new Date(s.last_synced_at))}</span>
            ) : (
              <span>not synced yet</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
