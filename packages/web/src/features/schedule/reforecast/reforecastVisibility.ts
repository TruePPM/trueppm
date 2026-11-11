import type { UnitemizedRun } from '../reconcile/reconcileState';

/**
 * Whether the reforecast panel may render, given when it was last dismissed.
 *
 * Dismiss hides the panel; it does not acknowledge anything. A recalculation too
 * large to itemize that arrives AFTER the dismissal re-opens it (#3158) — that
 * run's only explanation is the panel, so a dismissal the planner made about an
 * earlier run must not swallow it.
 *
 * Only the truncated path re-opens. Itemized rows arriving after a dismissal
 * still stay hidden for the rest of the visit, which is the pre-existing defect
 * tracked in #4947; widening this predicate to entries is that issue's fix.
 *
 * @param dismissedAt `Date.now()` at the last Dismiss, or `null` if never.
 * @param unitemizedRun The latest truncated run, if any.
 */
export function reforecastPanelVisible(
  dismissedAt: number | null,
  unitemizedRun: UnitemizedRun | null,
): boolean {
  if (dismissedAt === null) return true;
  return unitemizedRun !== null && unitemizedRun.since > dismissedAt;
}
