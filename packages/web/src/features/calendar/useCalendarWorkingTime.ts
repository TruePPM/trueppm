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
 * AND-compose weekly patterns the way the engine's `Calendar.compose` does: the fold
 * starts from the first calendar that applies, and Mon–Fri is what applies only when
 * none does. Seeding with Mon–Fri instead would block the weekends of a project whose
 * only calendar is a seven-day overlay, which the engine schedules through.
 */
function composeWorkingDays(masks: readonly number[]): number {
  return masks.length === 0 ? MON_FRI_MASK : masks.reduce((composed, mask) => composed & mask);
}

/**
 * Assemble what the Calendar grid needs to know about a project's working time.
 *
 * The calendars in force are the effective base, if any, plus the applied overlays,
 * the same set the engine composes. The reads that supply them:
 *  - the project read gives the effective base's name and mask;
 *  - the applied stack gives overlay masks and named exceptions, and the base's
 *    exceptions when the project overrides it;
 *  - the detail read gives an inherited base's exceptions. `effective_calendar` carries
 *    only a `holiday_count`, so it is skipped when that count says there are none.
 *
 * The preview is requested only when the applied stack has failed. It evaluates the
 * project's own calendar override rather than the effective base, so it is wrong for an
 * inheriting project and for one under a workspace lock, but with the stack gone it is
 * the only remaining source of dated blocks.
 *
 * Every read degrades independently: if one fails, the grid still draws from what
 * remains, down to the Mon–Fri default. `layoutSettling` ends at a read's first failed
 * attempt rather than after its retries, so a failing read never holds the grid back.
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

  const baseMask = effectiveCalendar?.working_days;
  const baseName = effectiveCalendar?.name;
  const overlays = applied.data?.overlays;
  const base = baseIsOverride ? applied.data?.base : inheritedBase.data;

  const mask = composeWorkingDays([
    ...(baseMask === undefined ? [] : [baseMask]),
    ...(overlays ?? []).map((o) => o.calendar.working_days),
  ]);
  const weekStartDay = deriveWeekStartDay(mask);
  const layoutSettling = projectLoading || (applied.isLoading && applied.failureCount === 0);

  // A failed background refetch still holds good data, so only an empty failure counts.
  const appliedFailed = applied.isError && applied.data === undefined;
  const baseFailed = inheritedBase.isError && inheritedBase.data === undefined;

  const weeks = viewWeekStarts(anchor, calView, weekStartDay);
  const preview = useCalendarPreview(
    appliedFailed ? projectId : null,
    formatISODate(weeks[0]),
    formatISODate(addDays(weeks[weeks.length - 1], 6)),
  );
  const days = preview.data?.days;

  const workingTime = useMemo<WorkingTimeInputs>(() => {
    const layers = overlays ?? [];
    return {
      mask,
      calendars: [
        ...(baseName === undefined || baseMask === undefined
          ? []
          : [{ name: baseName, workingDays: baseMask }]),
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

  return {
    workingTime,
    weekStartDay,
    layoutSettling,
    workingTimeIncomplete: projectFailed || baseFailed || appliedFailed,
  };
}
