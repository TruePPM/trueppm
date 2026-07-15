/**
 * Hook for the org-level working-calendar list (#968).
 *
 * Calendars are shared org resources (not project-scoped) — GET /api/v1/calendars/
 * returns every calendar any authenticated user may pick from. Used by the Project
 * General "Working calendar" override picker to offer a project-specific calendar
 * in place of the inherited workspace default.
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export interface WorkingCalendar {
  id: string;
  name: string;
  /** Single integer bitmask (Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64) —
   *  the wire shape `describeWorkingDays` expects, not a per-day array. */
  working_days: number;
  hours_per_day: number;
}

/** DRF PageNumberPagination envelope; the endpoint may also return a bare list. */
interface Paginated<T> {
  results: T[];
}

function isPaginated<T>(data: T[] | Paginated<T>): data is Paginated<T> {
  return !Array.isArray(data) && Array.isArray(data.results);
}

/** GET /api/v1/calendars/ — org-level working calendars available for override. */
export function useCalendars() {
  const query = useQuery({
    queryKey: ['calendars'],
    queryFn: async () => {
      // The list is paginated by the global default (PageNumberPagination); a
      // viewset that opts out returns a bare array — normalize both so the
      // picker never has to know which shape it got.
      const res = await apiClient.get<WorkingCalendar[] | Paginated<WorkingCalendar>>('/calendars/');
      return isPaginated(res.data) ? res.data.results : res.data;
    },
    // Calendars change rarely; a 5-min cache keeps the picker snappy and mirrors
    // the other settings roster hooks (useProjectMembers).
    staleTime: 5 * 60 * 1000,
  });

  return {
    calendars: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}
