import { useMemo } from 'react';
import { usePrograms } from '@/hooks/usePrograms';
import { useCalendarLibrary } from '@/hooks/useProjectCalendars';
import { useWorkspaceSettings } from '@/features/settings/hooks/useWorkspaceSettings';
import { summarizeWorkingCalendar, SYSTEM_DEFAULT_CALENDAR } from '@/features/settings/project/calendarDisplay';
import type { ProjectCalendarSource } from '@/api/types';

/** The inherited default calendar the Start sheet shows before any explicit override. */
export interface InheritedCalendar {
  /** `null` means "system default" — nothing up the chain sets a calendar. */
  id: string | null;
  name: string;
  summary: string;
  source: ProjectCalendarSource;
  loading: boolean;
}

const SYSTEM_DEFAULT_NAME = 'System default';

/**
 * Resolves the working calendar a *new* project would inherit if the caller never
 * touches the picker (#2728). There is no Project row yet to read
 * `effective_calendar`/`calendar_source` off of (those SerializerMethodFields need an
 * instance), so this reproduces the same `project ?? program ?? workspace ?? system`
 * precedence (ADR-0441) one level up, from data already broadly readable:
 *
 * - A selected program already carries its own resolved `effective_calendar` /
 *   `calendar_source` on every row `usePrograms()` returns (`ProgramSerializer`
 *   resolves the program ?? workspace ?? system chain server-side) — reused as-is,
 *   zero extra requests.
 * - With no program, the workspace's own `calendar` FK (`GET /workspace/`, readable
 *   by any authenticated member — `IsWorkspaceAdmin` allows GET for any member,
 *   admin-gates only writes) is looked up by id against the shared calendar library
 *   (`GET /calendars/`, readable by any authenticated user) to get its name.
 *
 * The sheet never *submits* this resolution — when the caller leaves the picker on
 * "inherited", `calendar` is simply omitted from the create payload and the server
 * performs the authoritative resolution itself (`resolve_effective_base_calendar`).
 * This hook exists to answer one question: what should the picker's default option
 * say, not what should be written.
 */
export function useInheritedCalendar(programId: string | null): InheritedCalendar {
  const { data: programs, isLoading: programsLoading } = usePrograms();
  const { data: workspace, isLoading: workspaceLoading } = useWorkspaceSettings();
  const { data: library, isLoading: libraryLoading } = useCalendarLibrary();

  return useMemo(() => {
    if (programId) {
      const program = (programs ?? []).find((p) => p.id === programId);
      if (program?.effective_calendar) {
        const effective = program.effective_calendar;
        return {
          id: effective.id,
          name: effective.name,
          summary: summarizeWorkingCalendar(effective),
          source: (program.calendar_source ?? 'workspace') as ProjectCalendarSource,
          loading: false,
        };
      }
      if (programsLoading) {
        return { id: null, name: 'Loading…', summary: '', source: 'system_default', loading: true };
      }
      // Defensively falls through to the workspace/system resolution below if the
      // selected program somehow isn't in the fetched list yet.
    }

    if (workspaceLoading || libraryLoading) {
      return { id: null, name: 'Loading…', summary: '', source: 'system_default', loading: true };
    }
    const calendarId = workspace?.calendar ?? null;
    const matched = calendarId ? (library ?? []).find((c) => c.id === calendarId) : undefined;
    if (matched) {
      return {
        id: matched.id,
        name: matched.name,
        summary: summarizeWorkingCalendar(matched),
        source: 'workspace',
        loading: false,
      };
    }
    return {
      id: null,
      name: SYSTEM_DEFAULT_NAME,
      summary: summarizeWorkingCalendar(SYSTEM_DEFAULT_CALENDAR),
      source: 'system_default',
      loading: false,
    };
  }, [programId, programs, programsLoading, workspace, workspaceLoading, library, libraryLoading]);
}
