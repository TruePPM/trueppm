import { useEffect } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { setActiveDateFormat } from '@/lib/formatUtcDate';

/**
 * Syncs the current user's `date_format` preference (#1953, ADR-0410) into the
 * module-level default read by the bare `fmtUtcShort`/`fmtUtcLong` calendar-date
 * formatters — so every forecast/CPM/schedule date already routing through
 * `formatUtcDate` (web-rule 189) reflects the user's chosen style with no
 * per-call-site change. Renders nothing.
 *
 * Timezone is NOT synced here — it only re-clocks instants, which read the
 * reactive `useUserDateFormat` hook directly (a calendar date is never
 * re-timezoned; that is the ADR-0144 invariant `formatUtcDate` keeps).
 *
 * Must be mounted inside the QueryClientProvider (it reads `useCurrentUser`).
 * Before the user resolves, the module default stays `'us'`, byte-identical to
 * the pre-#1953 behavior.
 */
export function DisplayFormatSync(): null {
  const { user } = useCurrentUser();
  const dateFormat = user?.date_format;
  useEffect(() => {
    setActiveDateFormat(dateFormat ?? 'us');
  }, [dateFormat]);
  return null;
}
