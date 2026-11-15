import { fmtUtcLong, fmtUtcShort } from '@/lib/formatUtcDate';
import {
  formatInstant,
  formatInstantDate,
  formatInstantTime,
  type ResolvedDatePrefs,
} from '@/lib/formatUserDateTime';

const DEFAULT_PREFS: ResolvedDatePrefs = Object.freeze({ timeZone: 'UTC', dateFormat: 'us' });

/**
 * Module factory for `vi.mock('@/hooks/useUserDateFormat', ...)` in suites that
 * render a component without a QueryClient (the real hook reads the current user
 * through TanStack Query). Binds the REAL formatters to fixed prefs, so assertions
 * still exercise the formatting path rather than a stub.
 *
 *   vi.mock('@/hooks/useUserDateFormat', async () =>
 *     (await import('@/test/mockUserDateFormat')).userDateFormatModule());
 */
export function userDateFormatModule(prefs: ResolvedDatePrefs = DEFAULT_PREFS) {
  return {
    useUserDateFormat: () => ({
      prefs,
      formatInstant: (iso: string | null | undefined) => formatInstant(iso, prefs),
      formatInstantDate: (iso: string | null | undefined, variant?: 'short' | 'medium' | 'long') =>
        formatInstantDate(iso, prefs, variant),
      formatInstantTime: (iso: string | null | undefined) => formatInstantTime(iso, prefs),
      fmtDateShort: (iso: string | null | undefined) => fmtUtcShort(iso, prefs.dateFormat),
      fmtDateLong: (iso: string | null | undefined) => fmtUtcLong(iso, prefs.dateFormat),
    }),
  };
}
