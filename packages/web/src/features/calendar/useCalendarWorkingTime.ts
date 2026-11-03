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
import type { ExceptionType, NamedException, WorkingTimeInputs } from './calendarUtils';

interface UseCalendarWorkingTimeArgs {
  projectId: string | null | undefined;
  effectiveCalendar: EffectiveCalendar | null | undefined;
  calendarSource: ProjectCalendarSource | undefined;
  startIso: string;
  endIso: string;
}

interface UseCalendarWorkingTimeResult {
  workingTime: WorkingTimeInputs;
  /** True when a failed read means holidays in force may be missing from `workingTime`. */
  holidaysUnavailable: boolean;
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
 * Every read degrades independently: while any is loading, or if it fails, the grid
 * still draws from what remains, down to the Mon–Fri default.
 */
export function useCalendarWorkingTime({
  projectId,
  effectiveCalendar,
  calendarSource,
  startIso,
  endIso,
}: UseCalendarWorkingTimeArgs): UseCalendarWorkingTimeResult {
  const preview = useCalendarPreview(projectId, startIso, endIso);
  const applied = useProjectCalendars(projectId);
  const baseIsOverride = calendarSource === 'project';
  const inheritedBase = useCalendarDetail(
    !baseIsOverride && effectiveCalendar && effectiveCalendar.holiday_count > 0
      ? effectiveCalendar.id
      : null,
  );

  const baseMask = effectiveCalendar?.working_days ?? MON_FRI_MASK;
  const days = preview.data?.days;
  const overlays = applied.data?.overlays;
  const base = baseIsOverride ? applied.data?.base : inheritedBase.data;

  const workingTime = useMemo<WorkingTimeInputs>(() => {
    const applied = overlays ?? [];
    return {
      mask: applied.reduce((mask, o) => mask & o.calendar.working_days, baseMask),
      previewByDate: new Map<string, PreviewDay>((days ?? []).map((d) => [d.date, d])),
      exceptions: [
        ...(base ? namedExceptions(base, 'holiday') : []),
        ...applied.flatMap((o) =>
          namedExceptions(o.calendar, o.role === 'workspace' ? 'shutdown' : 'holiday'),
        ),
      ],
    };
  }, [baseMask, days, overlays, base]);

  return {
    workingTime,
    holidaysUnavailable: inheritedBase.isError || (preview.isError && applied.isError),
  };
}
