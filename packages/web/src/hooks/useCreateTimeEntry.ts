/**
 * Create a manual `TimeEntry` against a task (issue 1416, ADR-0185 §2).
 *
 * The shared "log time" mutation behind the global quick-log popover (#1416) and
 * the My Work inline row popover (#1234): both `POST /tasks/{id}/time-entries/`
 * with a duration + date, then surface the same success + **Undo** toast. Undo
 * deletes the just-created entry (`DELETE /me/time-entries/{id}/`), which is
 * IDOR-safe because the row is owned by the logging user server-side.
 *
 * Kept out of `useActiveTimer` (which owns the *running-timer* lifecycle) because
 * that flow is a server singleton with a distinct start/stop shape; this hook is
 * the plain "I already know how long, log it" path with no timer state. Both
 * invalidate the same read surfaces (weekly grid + My Work) so a log from any
 * surface reconciles the others.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast';
import { formatLoggedMinutes } from '@/lib/formatElapsed';

/** A finalized `TimeEntry` as returned by `POST /tasks/{id}/time-entries/`. */
export interface LoggedTimeEntry {
  id: string;
  task: string;
  minutes: number;
  entry_date: string;
  note: string;
  source: string;
  server_version: number;
  created_at: string;
}

/** Arguments for a single quick-log. `taskLabel` is display-only — it feeds the
 *  toast copy so the confirmation names the task the entry landed on. */
export interface LogTimeVars {
  taskId: string;
  taskLabel: string;
  minutes: number;
  /** `YYYY-MM-DD`; the server rejects a future date and over-window backdates. */
  entryDate: string;
  note?: string;
}

/** Pull the first human-readable message out of a DRF 400 validation body
 *  (`{entry_date: ["…"], minutes: ["…"]}`) so the toast tells the user *why* the
 *  log was rejected (future date, over-window backdate) instead of a generic
 *  failure. Returns null when the shape is not a recognizable field-error map. */
function firstValidationMessage(error: unknown): string | null {
  if (!(error instanceof AxiosError) || error.response?.status !== 400) return null;
  const data: unknown = error.response.data;
  if (!data || typeof data !== 'object') return null;
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return null;
}

/**
 * Returns the create-time-entry mutation. On success it invalidates the weekly
 * grid and My Work reads and raises a `Logged {duration} on {task} · Undo` toast;
 * on error it surfaces a permission-specific message (403), the server's
 * validation reason (400), or a generic fallback.
 */
export function useCreateTimeEntry() {
  const qc = useQueryClient();

  const invalidateReads = () => {
    // Prefix match — every week's `['timesheet','week',mondayIso]` and the My
    // Work infinite query (`['me','work']`) reflect the new/removed entry.
    void qc.invalidateQueries({ queryKey: ['timesheet'] });
    void qc.invalidateQueries({ queryKey: ['me', 'work'] });
  };

  const undo = useMutation({
    mutationFn: async (entryId: string) => {
      await apiClient.delete(`/me/time-entries/${entryId}/`);
    },
    onSuccess: () => {
      invalidateReads();
      toast.info('Time entry removed.');
    },
    onError: () => toast.error('Could not remove the entry. Please try again.'),
  });

  return useMutation<LoggedTimeEntry, unknown, LogTimeVars>({
    mutationFn: async ({ taskId, minutes, entryDate, note }) => {
      const { data } = await apiClient.post<LoggedTimeEntry>(`/tasks/${taskId}/time-entries/`, {
        minutes,
        entry_date: entryDate,
        ...(note ? { note } : {}),
      });
      return data;
    },
    onSuccess: (entry, vars) => {
      invalidateReads();
      const logged = formatLoggedMinutes(entry.minutes);
      toast.action(
        `Logged ${logged} on ${vars.taskLabel}`,
        {
          label: 'Undo',
          ariaLabel: `Undo — remove the ${logged} entry logged on ${vars.taskLabel}`,
          onClick: () => undo.mutate(entry.id),
        },
        { variant: 'success' },
      );
    },
    onError: (error) => {
      if (error instanceof AxiosError && error.response?.status === 403) {
        toast.error("You don't have permission to log time on this project.");
        return;
      }
      toast.error(firstValidationMessage(error) ?? 'Could not log time. Please try again.');
    },
  });
}
