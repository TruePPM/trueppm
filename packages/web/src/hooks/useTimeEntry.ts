/**
 * Time-entry write + rollup hooks for the My Work contributor surface (#1234, ADR-0185 §4).
 *
 * Backs the row-anchored quick-log popover (`LogTimePopover`) and the per-row / header
 * "logged today" surfacing. Writes map onto the shipped entry endpoints:
 *   - create → `POST /tasks/{taskId}/time-entries/`  (owner is server-set — IDOR-safe)
 *   - delete → `DELETE /me/time-entries/{id}/`        (author-only soft delete → undo)
 *
 * Reads reuse the weekly rollup `GET /me/time-entries/?from=&to=` via `useWeekTimesheet`
 * (one shared query — React Query dedupes the many row subscribers to a single request),
 * so a logged-today chip and the header "N logged today · HH:MM this week" both read the
 * server's authoritative fold without a second endpoint.
 *
 * Writes are optimistic against that same week cache with rollback: the mutated entry is
 * folded into `results`, `totals` is recomputed locally (`computeTotals`) so the chip and
 * header move immediately, then `onSettled` invalidates to reconcile with the server. This
 * mirrors `useTimesheetCell` (#1435) — the two surfaces share one cache and stay coherent.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import {
  computeTotals,
  localTodayIso,
  mondayOf,
  type WeeklyEntry,
  type WeeklyResponse,
} from '@/features/timesheet/weekModel';
import { useWeekTimesheet, weekTimesheetKey } from './useWeekTimesheet';

/**
 * Browser-local today as an ISO `YYYY-MM-DD` (the grid's optimistic-total boundary and the
 * quick-log default date). Delegates to the shared {@link localTodayIso} so every time-entry
 * surface agrees on "today"; must be local, not UTC, or a west-of-UTC evening log defaults to
 * a future date the server rejects with 400 (#1926).
 */
export function todayIso(): string {
  return localTodayIso();
}

/** Preset chip → minutes mapping (design: 15m / 30m / 1h / 2h / 4h). */
export const TIME_PRESETS: { label: string; minutes: number }[] = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
  { label: '4h', minutes: 240 },
];

/** Task labels needed to synthesize an optimistic entry + the undo-toast copy. */
export interface LogTimeTaskMeta {
  taskId: string;
  taskShortId: string;
  taskName: string;
  projectId: string;
  projectName: string;
  /** The grid renders this; My Work never does, so an empty string is fine here. */
  projectCode?: string;
}

export interface LogTimeVars extends LogTimeTaskMeta {
  minutes: number;
  /** ISO `YYYY-MM-DD`; defaults to today at the call site. */
  entryDate: string;
  note?: string;
}

/** The single `TimeEntry` a create returns (ADR-0185 §4 `TimeEntrySerializer`). */
export interface TimeEntry {
  id: string;
  task: string;
  user: number;
  minutes: number;
  entry_date: string;
  note: string;
  source: string;
  server_version: number;
  created_at: string;
}

// Monotonic id source for optimistic rows — a module counter (not Date.now/Math.random)
// keeps ids deterministic for tests and unique within a session, matching the toast store.
let optimisticSeq = 0;

function synthEntry(vars: LogTimeVars): WeeklyEntry {
  optimisticSeq += 1;
  return {
    id: `optimistic-${optimisticSeq}`,
    task: vars.taskId,
    task_short_id: vars.taskShortId,
    task_name: vars.taskName,
    project: vars.projectId,
    project_code: vars.projectCode ?? '',
    project_name: vars.projectName,
    minutes: vars.minutes,
    entry_date: vars.entryDate,
    note: vars.note ?? '',
    source: 'manual',
    server_version: 0,
    created_at: `${vars.entryDate}T00:00:00Z`,
  };
}

/** Rewrite the cached week `results` and recompute its totals in one place. */
function writeWeek(
  queryClient: ReturnType<typeof useQueryClient>,
  mondayIso: string,
  mutate: (results: WeeklyEntry[]) => WeeklyEntry[],
): WeeklyResponse | undefined {
  const key = weekTimesheetKey(mondayIso);
  const snapshot = queryClient.getQueryData<WeeklyResponse>(key);
  if (snapshot) {
    const results = mutate(snapshot.results);
    queryClient.setQueryData<WeeklyResponse>(key, {
      ...snapshot,
      results,
      totals: computeTotals(results, todayIso()),
    });
  }
  return snapshot;
}

interface CreateCtx {
  mondayIso: string;
  snapshot: WeeklyResponse | undefined;
}

/**
 * Log time on a task from the My Work surface (create). Optimistic against the week cache
 * with rollback; returns the created entry so the caller can wire the undo toast to its id.
 */
export function useCreateTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation<TimeEntry, unknown, LogTimeVars, CreateCtx>({
    mutationFn: async (vars) => {
      const { data } = await apiClient.post<TimeEntry>(
        `/tasks/${vars.taskId}/time-entries/`,
        { minutes: vars.minutes, entry_date: vars.entryDate, note: vars.note ?? '' },
      );
      return data;
    },
    onMutate: async (vars) => {
      const mondayIso = mondayOf(vars.entryDate);
      await queryClient.cancelQueries({ queryKey: weekTimesheetKey(mondayIso) });
      const snapshot = writeWeek(queryClient, mondayIso, (results) => [
        ...results,
        synthEntry(vars),
      ]);
      return { mondayIso, snapshot };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.snapshot) {
        queryClient.setQueryData(weekTimesheetKey(ctx.mondayIso), ctx.snapshot);
      }
    },
    onSettled: (_data, _err, _vars, ctx) => {
      if (ctx) void queryClient.invalidateQueries({ queryKey: weekTimesheetKey(ctx.mondayIso) });
    },
  });
}

export interface DeleteTimeEntryVars {
  entryId: string;
  /** Entry's date — locates the week cache to update optimistically. */
  entryDate: string;
}

interface DeleteCtx {
  mondayIso: string;
  snapshot: WeeklyResponse | undefined;
}

/**
 * Delete a time entry (the undo affordance and author-only removal). Author-only is
 * enforced server-side (the `/me/time-entries/` queryset is scoped to the caller — a
 * foreign id 404s). Optimistic removal from the week cache with rollback.
 */
export function useDeleteTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, DeleteTimeEntryVars, DeleteCtx>({
    mutationFn: async ({ entryId }) => {
      await apiClient.delete(`/me/time-entries/${entryId}/`);
    },
    onMutate: async ({ entryId, entryDate }) => {
      const mondayIso = mondayOf(entryDate);
      await queryClient.cancelQueries({ queryKey: weekTimesheetKey(mondayIso) });
      const snapshot = writeWeek(queryClient, mondayIso, (results) =>
        results.filter((e) => e.id !== entryId),
      );
      return { mondayIso, snapshot };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.snapshot) {
        queryClient.setQueryData(weekTimesheetKey(ctx.mondayIso), ctx.snapshot);
      }
    },
    onSettled: (_data, _err, _vars, ctx) => {
      if (ctx) void queryClient.invalidateQueries({ queryKey: weekTimesheetKey(ctx.mondayIso) });
    },
  });
}

export interface TimeRollup {
  /** Minutes logged across all tasks today. */
  todayMinutes: number;
  /** Minutes logged this ISO week. */
  weekMinutes: number;
  /** Minutes this user logged on one task today (drives the per-row chip). */
  loggedTodayForTask: (taskId: string) => number;
}

/**
 * The current week's logged-time rollup for the My Work header and per-row chips.
 *
 * Reads the shared `useWeekTimesheet` query for the current ISO week; `by_cell` (keyed
 * `"<taskId>|<iso>"`) gives per-row "logged today" with no extra request. Returns zeros
 * until the read resolves, so callers render an honest empty state rather than a spinner.
 */
export function useTimeRollup(): TimeRollup {
  const monday = mondayOf(todayIso());
  const { data } = useWeekTimesheet(monday);
  const totals = data?.totals;
  const today = todayIso();
  return {
    todayMinutes: totals?.today_minutes ?? 0,
    weekMinutes: totals?.week_minutes ?? 0,
    loggedTodayForTask: (taskId: string) => totals?.by_cell[`${taskId}|${today}`] ?? 0,
  };
}
