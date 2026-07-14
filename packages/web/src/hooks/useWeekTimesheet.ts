/**
 * Data hooks for the weekly cross-project timesheet grid (#1435, ADR-0224).
 *
 * The grid **read** reuses the shipped `GET /me/time-entries/?from=&to=` (ADR-0185 §4):
 * the caller's entries across every accessible project plus precomputed `totals` and the
 * week's `submission` marker. Per-cell **writes** map onto the existing entry endpoints —
 * a cell is 0 or 1 entry (create / PATCH / DELETE); a ≥2-entry cell is read-only in the
 * grid (ADR-0224) and never reaches `useTimesheetCell`. The `submit` action toggles the
 * per-user-per-week marker.
 *
 * Cell writes are optimistic against the weekly cache with rollback: `totals` are
 * recomputed locally from the mutated `results` (`computeTotals`) so the row/day/week
 * numbers move immediately, then `onSettled` invalidates to reconcile against the server's
 * authoritative fold.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast';
import { isClientRejection } from '@/lib/apiError';
import {
  computeTotals,
  localTodayIso,
  type WeeklyEntry,
  type WeeklyResponse,
} from '@/features/timesheet/weekModel';
import { addDaysIso } from '@/features/timesheet/weekModel';

/** Query key for a week's timesheet, keyed by its Monday ISO date. */
export const weekTimesheetKey = (mondayIso: string) => ['timesheet', 'week', mondayIso] as const;

async function fetchWeek(mondayIso: string): Promise<WeeklyResponse> {
  const to = addDaysIso(mondayIso, 6);
  const { data } = await apiClient.get<WeeklyResponse>('/me/time-entries/', {
    params: { from: mondayIso, to },
  });
  return data;
}

/** The week's entries + totals + submission marker for the week starting `mondayIso`. */
export function useWeekTimesheet(mondayIso: string) {
  return useQuery({
    queryKey: weekTimesheetKey(mondayIso),
    queryFn: () => fetchWeek(mondayIso),
    // A contributor logs from multiple surfaces (inline, timer, this grid) and devices;
    // refetch on focus reconciles entries logged elsewhere (ADR-0185 §4).
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}

/** Denormalized task labels needed to synthesize an optimistic created entry. */
export interface CellTaskMeta {
  taskId: string;
  taskShortId: string;
  taskName: string;
  projectId: string;
  projectCode: string;
  projectName: string;
}

export interface CellEditVars {
  meta: CellTaskMeta;
  date: string;
  /** New total minutes for the cell (0 clears it). */
  minutes: number;
  /** The existing entry id when the cell holds exactly one entry, else null. */
  entryId: string | null;
}

/**
 * Create / update / clear a single `(task, date)` grid cell (ADR-0224 mapping):
 *   - `entryId != null`, `minutes > 0`  → PATCH the entry's minutes
 *   - `entryId != null`, `minutes == 0` → DELETE (soft) the entry
 *   - `entryId == null`, `minutes > 0`  → POST a new entry on the task
 *   - `entryId == null`, `minutes == 0` → no-op
 * Optimistic against the week cache with rollback.
 */
export function useTimesheetCell(mondayIso: string) {
  const qc = useQueryClient();
  const key = weekTimesheetKey(mondayIso);

  return useMutation({
    mutationFn: async ({ meta, date, minutes, entryId }: CellEditVars): Promise<void> => {
      if (entryId !== null) {
        if (minutes > 0) {
          await apiClient.patch(`/me/time-entries/${entryId}/`, { minutes });
        } else {
          await apiClient.delete(`/me/time-entries/${entryId}/`);
        }
        return;
      }
      if (minutes > 0) {
        await apiClient.post(`/tasks/${meta.taskId}/time-entries/`, {
          minutes,
          entry_date: date,
        });
      }
    },
    onMutate: async (vars: CellEditVars) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<WeeklyResponse>(key);
      if (previous) {
        qc.setQueryData<WeeklyResponse>(key, applyCellEdit(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
      // A 4xx validation rejection is shown inline on the offending cell by the
      // page (#1945); a generic "try again" toast on top would be redundant and
      // misleading — retrying the same value won't help. Only surface a toast
      // for non-validation failures (network / 5xx).
      if (!isClientRejection(err)) {
        toast.error('Could not save that time. Please try again.');
      }
    },
    onSettled: () => {
      // Reconcile against the server's authoritative fold (real ids, exact totals).
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/**
 * Apply a cell edit to a cached weekly response (pure) so the optimistic update and its
 * unit test share one implementation. A patch updates the entry's minutes; a clear removes
 * it; a create appends a synthetic entry (temp id, replaced on refetch). `totals` are
 * recomputed from the mutated results.
 */
export function applyCellEdit(prev: WeeklyResponse, vars: CellEditVars): WeeklyResponse {
  const { meta, date, minutes, entryId } = vars;
  let results: WeeklyEntry[];
  if (entryId !== null) {
    results =
      minutes > 0
        ? prev.results.map((e) => (e.id === entryId ? { ...e, minutes } : e))
        : prev.results.filter((e) => e.id !== entryId);
  } else if (minutes > 0) {
    const optimistic: WeeklyEntry = {
      id: `optimistic-${meta.taskId}-${date}`,
      task: meta.taskId,
      task_short_id: meta.taskShortId,
      task_name: meta.taskName,
      project: meta.projectId,
      project_code: meta.projectCode,
      project_name: meta.projectName,
      minutes,
      entry_date: date,
      note: '',
      source: 'manual',
      server_version: 0,
      created_at: new Date().toISOString(),
    };
    results = [...prev.results, optimistic];
  } else {
    results = prev.results;
  }
  return { ...prev, results, totals: computeTotals(results, localTodayIso()) };
}

/**
 * Submit ("mark done") or un-submit the week's timesheet (ADR-0224). Optimistically flips
 * the cached `submission` and reconciles on settle. Submission does not lock entries — it
 * is a signal the 0.5 approval epic (#100) reads.
 */
export function useSubmitWeek(mondayIso: string) {
  const qc = useQueryClient();
  const key = weekTimesheetKey(mondayIso);

  return useMutation({
    mutationFn: async (submit: boolean): Promise<void> => {
      const url = `/me/timesheets/${mondayIso}/submit`;
      if (submit) {
        await apiClient.post(url);
      } else {
        await apiClient.delete(url);
      }
    },
    onMutate: async (submit: boolean) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<WeeklyResponse>(key);
      if (previous) {
        qc.setQueryData<WeeklyResponse>(key, {
          ...previous,
          submission: {
            ...previous.submission,
            submitted: submit,
            submitted_at: submit ? new Date().toISOString() : null,
          },
        });
      }
      return { previous };
    },
    onError: (_err, _submit, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
      toast.error('Could not update the week. Please try again.');
    },
    onSuccess: (_data, submit) => {
      toast.info(submit ? 'Week submitted.' : 'Week reopened.');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}
