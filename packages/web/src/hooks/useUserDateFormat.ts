import { useMemo } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { fmtUtcLong, fmtUtcShort } from '@/lib/formatUtcDate';
import {
  formatInstant,
  formatInstantDate,
  formatInstantTime,
  resolveUserDatePrefs,
  type ResolvedDatePrefs,
} from '@/lib/formatUserDateTime';

/**
 * Binds the per-user display preferences (#1953, ADR-0410) to the current user.
 *
 * Returns formatters for BOTH scopes so a component reads its dates from one
 * reactive source:
 *   - `formatInstant` / `formatInstantDate` / `formatInstantTime` — INSTANTS
 *     (timestamps with a time-of-day): re-clocked to the user's zone + styled.
 *   - `fmtDateShort` / `fmtDateLong` — CALENDAR DATES (date-only forecast/CPM/
 *     schedule values): UTC-pinned (never re-clocked) but styled by the user's
 *     date format.
 *   - `prefs` — the resolved prefs, for passing to pure helpers (e.g.
 *     `formatRelative(date, now, prefs)`).
 *
 * Consuming this hook makes a surface fully reactive to a preference change.
 * Surfaces still calling the bare `fmtUtcShort`/`fmtUtcLong` pick up the format
 * via the module default that `AppShell` syncs (see `setActiveDateFormat`).
 */
export function useUserDateFormat(): {
  prefs: ResolvedDatePrefs;
  formatInstant: (iso: string | null | undefined) => string;
  formatInstantDate: (iso: string | null | undefined) => string;
  formatInstantTime: (iso: string | null | undefined) => string;
  fmtDateShort: (iso: string | null | undefined) => string;
  fmtDateLong: (iso: string | null | undefined) => string;
} {
  const { user } = useCurrentUser();
  const prefs = useMemo(
    () => resolveUserDatePrefs(user?.timezone, user?.date_format),
    [user?.timezone, user?.date_format],
  );
  return useMemo(
    () => ({
      prefs,
      formatInstant: (iso) => formatInstant(iso, prefs),
      formatInstantDate: (iso) => formatInstantDate(iso, prefs),
      formatInstantTime: (iso) => formatInstantTime(iso, prefs),
      fmtDateShort: (iso) => fmtUtcShort(iso, prefs.dateFormat),
      fmtDateLong: (iso) => fmtUtcLong(iso, prefs.dateFormat),
    }),
    [prefs],
  );
}
