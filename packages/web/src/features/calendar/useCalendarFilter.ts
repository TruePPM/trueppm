/**
 * useCalendarFilter — manages calView URL param (week | month) and
 * anchorDate state for the Calendar view.
 *
 * State is stored in the URL so it survives navigation and can be bookmarked:
 *   ?view=calendar&calView=month&calAnchor=2026-03-01
 * plus the optional `calGroup=assignee` and `calMine=1` filters.
 */

import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { todayLocalIso } from '@/features/schedule/scheduleUtils';
import type { CalViewMode } from './calendarUtils';
import {
  isValidISODate,
  parseCalViewMode,
  parseUTCDate,
  nextMonth,
  prevMonth,
  nextWeek,
  prevWeek,
} from './calendarUtils';

const DEFAULT_MODE: CalViewMode = 'month';

interface UseCalendarFilterReturn {
  calView: CalViewMode;
  anchorIso: string;
  setCalView: (mode: CalViewMode) => void;
  /** Week view only: one swimlane per assignee (`?calGroup=assignee`, #3169). */
  groupByAssignee: boolean;
  setGroupByAssignee: (on: boolean) => void;
  /** Show only tasks assigned to the current user (`?calMine=1`, #3171). */
  mineOnly: boolean;
  setMineOnly: (on: boolean) => void;
  goToToday: () => void;
  goNext: () => void;
  goPrev: () => void;
}

export function useCalendarFilter(): UseCalendarFilterReturn {
  const [searchParams, setSearchParams] = useSearchParams();

  // The URL is shareable and so arrives truncated or hand-typed: validate both
  // params and degrade to the defaults rather than feeding an Invalid Date (a
  // render-time RangeError in week mode) or an unknown mode into the view.
  const calView = parseCalViewMode(searchParams.get('calView'), DEFAULT_MODE);
  const rawAnchor = searchParams.get('calAnchor');
  const anchorIso = isValidISODate(rawAnchor) ? rawAnchor : todayLocalIso();

  const groupByAssignee = searchParams.get('calGroup') === 'assignee';
  const mineOnly = searchParams.get('calMine') === '1';

  // A null value deletes the param, so an "off" filter leaves the URL clean.
  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setCalView = useCallback(
    (mode: CalViewMode) => updateParams({ calView: mode }),
    [updateParams],
  );

  const setGroupByAssignee = useCallback(
    (on: boolean) => updateParams({ calGroup: on ? 'assignee' : null }),
    [updateParams],
  );

  const setMineOnly = useCallback(
    (on: boolean) => updateParams({ calMine: on ? '1' : null }),
    [updateParams],
  );

  const goToToday = useCallback(() => updateParams({ calAnchor: todayLocalIso() }), [updateParams]);

  const goNext = useCallback(() => {
    const anchor = parseUTCDate(anchorIso);
    const next = calView === 'month' ? nextMonth(anchor) : nextWeek(anchor);
    updateParams({ calAnchor: next.toISOString().slice(0, 10) });
  }, [anchorIso, calView, updateParams]);

  const goPrev = useCallback(() => {
    const anchor = parseUTCDate(anchorIso);
    const prev = calView === 'month' ? prevMonth(anchor) : prevWeek(anchor);
    updateParams({ calAnchor: prev.toISOString().slice(0, 10) });
  }, [anchorIso, calView, updateParams]);

  return {
    calView,
    anchorIso,
    setCalView,
    groupByAssignee,
    setGroupByAssignee,
    mineOnly,
    setMineOnly,
    goToToday,
    goNext,
    goPrev,
  };
}
