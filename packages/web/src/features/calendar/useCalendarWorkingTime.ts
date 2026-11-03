import { useMemo } from 'react';
import type { EffectiveCalendar, ProjectCalendarSource } from '@/api/types';
import { MON_FRI_MASK } from '@/features/schedule/reconcile/reconcileCopy';
import {
  useCalendarDetail,
  useCalendarPreview,
  useProjectCalendars,
  type Calendar,
  type PreviewDay,
} from '@/hooks/useProjectCalendars';
import {
  addDays,
  deriveWeekStartDay,
  formatISODate,
  viewWeekStarts,
  type CalViewMode,
  type ExceptionType,
  type NamedException,
  type WeekStartDay,
  type WorkingTimeInputs,
} from './calendarUtils';

interface UseCalendarWorkingTimeArgs {
  projectId: string | null | undefined;
  effectiveCalendar: EffectiveCalendar | null | undefined;
  calendarSource: ProjectCalendarSource | undefined;
  /** The project read has not answered yet. */
  projectLoading: boolean;
  /** The project read failed, so the base calendar above is unknown. */
  projectFailed: boolean;
  anchor: Date;
  calView: CalViewMode;
}

interface UseCalendarWorkingTimeResult {
  workingTime: WorkingTimeInputs;
  /** Read off the composed pattern, so the first column is never a day the mask blocks. */
  weekStartDay: WeekStartDay;
  /**
   * True until the reads that decide the column layout have first answered. Drawing
   * before then would rebuild every row under the user when the week start moves.
   */
  layoutSettling: boolean;
  /** True when a failed read means `workingTime` may not be the calendars in force. */
  workingTimeIncomplete: boolean;
}

function namedExceptions(calendar: Calendar, type: ExceptionType): NamedException[] {
  return calendar.exceptions.map((e) => ({
    start: e.exc_start,
    end: e.exc_end,
    name: e.description.trim() || calendar.name,
    calendarName: calendar.name,
    type,
  }));
}

/**
 * Assemble what the Calendar grid needs to know about a project's working time.
 *
 * The calendars in force are the effective base plus the applied overlays, the same
 * set the engine composes. Three reads supply them, because none covers the whole:
 *  - the preview gives the server's per-day verdict but no exception names, and it
 *    evaluates only the project's own calendar override, never an inherited base;
 *  - the applied stack gives overlay masks and named exceptions, and the base only
 *    when the project overrides it;
 *  - the detail read fills in an inherited base. `effective_calendar` carries only a
 *    `holiday_count`, so it is skipped when that count says there is nothing to fetch.
 *
 * Every read degrades independently: if one fails, the grid still draws from what
 * remains, down to the Mon–Fri default. `layoutSettling` ends at a read's first failed
 * attempt rather than after its retries, so a failing read never holds the grid back.
 *
 * The preview waits for `layoutSettling` because its window depends on the week start,
 * which depends on the applied stack; asking sooner would fetch a window nobody draws.
 */
export function useCalendarWorkingTime({
  projectId,
  effectiveCalendar,
  calendarSource,
  projectLoading,
  projectFailed,
  anchor,
  calView,
}: UseCalendarWorkingTimeArgs): UseCalendarWorkingTimeResult {
  const applied = useProjectCalendars(projectId);
  const baseIsOverride = calendarSource === 'project';
  const inheritedBase = useCalendarDetail(
    !baseIsOverride && effectiveCalendar && effectiveCalendar.holiday_count > 0
      ? effectiveCalendar.id
      : null,
  );

  const baseMask = effectiveCalendar?.working_days ?? MON_FRI_MASK;
  const baseName = effectiveCalendar?.name;
  const overlays = applied.data?.overlays;
  const base = baseIsOverride ? applied.data?.base : inheritedBase.data;

  const mask = (overlays ?? []).reduce((m, o) => m & o.calendar.working_days, baseMask);
  const weekStartDay = deriveWeekStartDay(mask);
  const layoutSettling = projectLoading || (applied.isLoading && applied.failureCount === 0);

  const weeks = viewWeekStarts(anchor, calView, weekStartDay);
  const preview = useCalendarPreview(
    layoutSettling ? null : projectId,
    formatISODate(weeks[0]),
    formatISODate(addDays(weeks[weeks.length - 1], 6)),
  );
  const days = preview.data?.days;

  const workingTime = useMemo<WorkingTimeInputs>(() => {
    const layers = overlays ?? [];
    return {
      mask,
      calendars: [
        ...(baseName === undefined ? [] : [{ name: baseName, workingDays: baseMask }]),
        ...layers.map((o) => ({ name: o.calendar.name, workingDays: o.calendar.working_days })),
      ],
      previewByDate: new Map<string, PreviewDay>((days ?? []).map((d) => [d.date, d])),
      exceptions: [
        ...(base ? namedExceptions(base, 'holiday') : []),
        ...layers.flatMap((o) =>
          namedExceptions(o.calendar, o.role === 'workspace' ? 'shutdown' : 'holiday'),
        ),
      ],
    };
  }, [mask, baseMask, baseName, days, overlays, base]);

  // A failed background refetch still holds good data, so only an empty failure counts.
  const previewFailed = preview.isError && preview.data === undefined;
  const appliedFailed = applied.isError && applied.data === undefined;
  const baseFailed = inheritedBase.isError && inheritedBase.data === undefined;

  return {
    workingTime,
    weekStartDay,
    layoutSettling,
    workingTimeIncomplete: projectFailed || baseFailed || (previewFailed && appliedFailed),
  };
}
