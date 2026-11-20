import type { Task } from '@/types';

const DAY_MS = 86_400_000;

/**
 * Calendar days the task's forecast finish lands AFTER its soft deadline
 * (#690), or `null` when there is nothing to say: no deadline, no computed
 * finish yet, or the finish is on or before the deadline.
 *
 * Calendar days, not working days, on purpose: a deadline is a date someone
 * outside the schedule committed to ("due Friday"), so "3 days past deadline"
 * has to mean three days on the wall calendar. A milestone has no span, so its
 * single date (`start`) is what is compared. UTC arithmetic so the count never
 * drifts by a timezone offset.
 */
export function deadlineSlipDays(
  task: Pick<Task, 'deadline' | 'finish' | 'start' | 'isMilestone'>,
): number | null {
  if (!task.deadline) return null;
  const forecast = task.isMilestone ? task.start : task.finish;
  if (!forecast) return null;
  const days = Math.round(
    (new Date(forecast + 'T00:00:00Z').getTime() -
      new Date(task.deadline + 'T00:00:00Z').getTime()) /
      DAY_MS,
  );
  return days > 0 ? days : null;
}
