import { useMemo } from 'react';
import { useProject } from '@/hooks/useProject';
import { useProjectId } from '@/hooks/useProjectId';
import { useCalendarWorkingTime } from '@/features/calendar/useCalendarWorkingTime';
import { MON_FRI_WORKING_TIME, type WorkingTimeConfig } from './engine';

/**
 * The project's non-working time for the Gantt background (#1498).
 *
 * Reuses the Calendar view's working-time composition (effective base calendar +
 * applied overlays, the same set the CPM engine composes) so the canvas and the
 * Calendar grid cannot disagree about which days are skipped. Until the project
 * read answers, or when there is no single project (the program schedule), it
 * returns the stable Mon–Fri constant — identical to the pre-#1498 weekend shading,
 * and the same identity every render so the engine does not repaint for nothing.
 */
export function useScheduleWorkingTime(): WorkingTimeConfig {
  const projectId = useProjectId() ?? null;
  const projectRead = useProject(projectId);
  const detail = projectRead.data;
  // The preview read only fires when the applied stack failed and needs a window;
  // a month around a fixed anchor is enough for that last-resort path.
  const anchor = useMemo(() => new Date(), []);
  const { workingTime } = useCalendarWorkingTime({
    projectId,
    effectiveCalendar: detail?.effective_calendar,
    calendarSource: detail?.calendar_source,
    projectLoading: projectRead.isLoading && projectRead.failureCount === 0,
    projectFailed: !!projectRead.error && !detail,
    anchor,
    calView: 'month',
  });

  const hasCalendar = !!detail?.effective_calendar;
  return useMemo<WorkingTimeConfig>(
    () =>
      hasCalendar
        ? {
            mask: workingTime.mask,
            exceptions: workingTime.exceptions.map((e) => ({ start: e.start, end: e.end })),
          }
        : MON_FRI_WORKING_TIME,
    [hasCalendar, workingTime.mask, workingTime.exceptions],
  );
}
