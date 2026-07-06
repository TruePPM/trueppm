import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Working-calendar composition hooks (ADR-0251, #906).
 *
 * A project's non-working day mask is the UNION of a base project calendar plus
 * zero or more overlay calendars (reusable holiday sets and workspace
 * shutdowns). Scheduler+ users compose the stack here; CPM refuses to place
 * work on any day blocked by any applied calendar.
 *
 * The API surface (all under /projects/{id}/calendars/):
 *  - GET  /calendars/          → the shared org calendar library (pickable).
 *  - GET  /projects/{id}/calendars/          → the applied set { base, overlays, applied }.
 *  - PUT  /projects/{id}/calendars/          → ATOMIC REPLACE of the applied set.
 *  - GET  /projects/{id}/calendars/preview/  → effective working/non-working days.
 *
 * The interfaces below are defined locally (not sourced from the generated
 * `src/api/types.ts`) so this feature isn't blocked on an OpenAPI regen; they
 * mirror the server shapes exactly.
 */

/** A day the calendar marks non-working (weekend / holiday / shutdown range). */
export interface CalendarException {
  id: string;
  exc_start: string;
  exc_end: string;
  description: string;
}

/** A reusable calendar from the shared org library. */
export interface Calendar {
  id: string;
  server_version: number;
  name: string;
  /** Working-day bitmask: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64. */
  working_days: number;
  hours_per_day: number;
  timezone: string;
  exceptions: CalendarException[];
}

/** The role an applied calendar plays in the stack. */
export type CalendarRole = 'project' | 'holidays' | 'workspace';

/** Roles an OVERLAY (non-base) calendar may carry in the PUT payload. */
export type OverlayRole = 'holidays' | 'workspace';

/** An entry in the project's applied calendar stack. */
export interface AppliedCalendar {
  /** Stable id of the applied-layer join row; `null` for the base entry. */
  layer_id: string | null;
  role: CalendarRole;
  sort_order: number;
  calendar: Calendar;
}

/** GET /projects/{id}/calendars/ response. */
export interface ProjectCalendars {
  base: Calendar | null;
  overlays: AppliedCalendar[];
  applied: AppliedCalendar[];
}

/** One overlay in the atomic-replace PUT body. */
export interface OverlayInput {
  calendar_id: string;
  role: OverlayRole;
}

/** PUT /projects/{id}/calendars/ body. */
export interface UpdateProjectCalendarsInput {
  base_calendar_id: string | null;
  overlays: OverlayInput[];
}

/** Which applied calendar(s) block a non-working preview day. */
export interface PreviewSource {
  role: CalendarRole;
  calendar_id: string;
  name: string;
}

/** One day in the effective-working-time preview. */
export interface PreviewDay {
  date: string;
  working: boolean;
  sources: PreviewSource[];
}

/** GET /projects/{id}/calendars/preview/ response. */
export interface CalendarPreview {
  start: string;
  end: string;
  days: PreviewDay[];
}

/**
 * Co-located query-key factory. `applied` and `preview` are invalidated
 * together after a successful PUT so the stack and the month grid stay
 * coherent; `preview` is further keyed by window so paging the month strip
 * doesn't thrash the cache.
 */
export const calendarKeys = {
  all: ['calendars'] as const,
  library: () => [...calendarKeys.all, 'library'] as const,
  applied: (projectId: string | null | undefined) =>
    [...calendarKeys.all, 'applied', projectId] as const,
  preview: (projectId: string | null | undefined, start: string, end: string) =>
    [...calendarKeys.all, 'preview', projectId, start, end] as const,
};

/** GET /calendars/ — the shared org calendar library (pickable in the picker). */
export function useCalendarLibrary() {
  return useQuery<Calendar[]>({
    queryKey: calendarKeys.library(),
    queryFn: async () => {
      const res = await apiClient.get<Calendar[] | { results: Calendar[] }>('/calendars/');
      // The library endpoint may be paginated (DRF list) or a bare array;
      // normalize both so callers always receive Calendar[].
      const data = res.data;
      return Array.isArray(data) ? data : (data.results ?? []);
    },
    staleTime: 5 * 60 * 1000, // library changes rarely
  });
}

/** GET /projects/{id}/calendars/ — the applied base + overlay stack. */
export function useProjectCalendars(projectId: string | null | undefined) {
  return useQuery<ProjectCalendars>({
    queryKey: calendarKeys.applied(projectId),
    queryFn: async () => {
      const res = await apiClient.get<ProjectCalendars>(`/projects/${projectId}/calendars/`);
      return res.data;
    },
    enabled: !!projectId,
  });
}

/** GET /projects/{id}/calendars/preview/ — effective days for [start, end]. */
export function useCalendarPreview(
  projectId: string | null | undefined,
  start: string,
  end: string,
) {
  return useQuery<CalendarPreview>({
    queryKey: calendarKeys.preview(projectId, start, end),
    queryFn: async () => {
      const res = await apiClient.get<CalendarPreview>(
        `/projects/${projectId}/calendars/preview/`,
        { params: { start, end } },
      );
      return res.data;
    },
    enabled: !!projectId,
  });
}

/**
 * PUT /projects/{id}/calendars/ — atomic replace of the applied set.
 *
 * On success both the applied-stack and preview queries are invalidated so the
 * stack, the month grid, and the "working days lost" summary all recompute from
 * the freshly-saved server state. Applying a calendar reshapes the schedule
 * (CPM recomputes server-side); the panel does not attempt an optimistic
 * preview because the preview endpoint only reflects saved state.
 */
export function useUpdateProjectCalendars(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProjectCalendarsInput) => {
      const res = await apiClient.put<ProjectCalendars>(
        `/projects/${projectId}/calendars/`,
        input,
      );
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(calendarKeys.applied(projectId), data);
      // Preview is windowed — we can't patch it in place, so invalidate every
      // window for this project and let the visible one refetch.
      void queryClient.invalidateQueries({
        queryKey: [...calendarKeys.all, 'preview', projectId],
      });
    },
  });
}

/**
 * Build the atomic-replace PUT body from the current applied set plus a delta.
 *
 * Existing overlays keep their server-assigned role (a `project`-role overlay
 * cannot exist — only the base is `project`); newly-added library calendars
 * join as `holidays` overlays (the common case — reusable holiday sets).
 * Workspace-shutdown calendars are provisioned by a workspace admin and, once
 * present, are preserved with their `workspace` role but are not user-addable
 * from this picker.
 *
 * @param current  The project's currently-applied calendars.
 * @param addIds   Library calendar ids to add as `holidays` overlays.
 * @param removeLayerIds  Applied-layer ids to drop.
 */
export function buildUpdatePayload(
  current: ProjectCalendars,
  addIds: string[],
  removeLayerIds: string[],
): UpdateProjectCalendarsInput {
  const removed = new Set(removeLayerIds);
  const kept: OverlayInput[] = current.overlays
    .filter((o) => o.layer_id === null || !removed.has(o.layer_id))
    .map((o) => ({
      calendar_id: o.calendar.id,
      // Base can never be an overlay; narrow the union to OverlayRole.
      role: (o.role === 'workspace' ? 'workspace' : 'holidays') as OverlayRole,
    }));
  const added: OverlayInput[] = addIds.map((id) => ({ calendar_id: id, role: 'holidays' }));
  return {
    base_calendar_id: current.base?.id ?? null,
    overlays: [...kept, ...added],
  };
}
