/**
 * Is a task near-critical, judged from its total float and the project's
 * threshold? The one client-side derivation, shared by the task drawer (which
 * mounts "Why critical?" for such a task) and the shell v2 canvas (which frames
 * its bar) so the two can never disagree about the same row.
 *
 * The bands are the server's (`float_band`, the driving-chain payload):
 * critical is float 0, near-critical is `0 < float <= threshold`, ample is
 * above it. So float 0 is never near-critical here, even on a task whose
 * `isCritical` flag has not caught up.
 *
 * A `null` threshold means the project's `effective_near_critical_threshold_days`
 * has not loaded yet; the answer is then `false` rather than a guessed default,
 * because a frame drawn from a guess would contradict the setting the user
 * actually chose for the length of one fetch.
 *
 * @param task - The task's critical flag and total float, in working days.
 * @param thresholdDays - The server's effective threshold, or null until known.
 * @returns True only for a non-critical task inside the near-critical band.
 */
export function isNearCriticalByFloat(
  task: { isCritical: boolean; totalFloat?: number | null },
  thresholdDays: number | null | undefined,
): boolean {
  if (task.isCritical || thresholdDays == null) return false;
  const float = task.totalFloat;
  return float != null && float > 0 && float <= thresholdDays;
}
