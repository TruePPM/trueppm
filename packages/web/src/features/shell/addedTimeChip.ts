import { projectViewSegment } from './useLocationModel';

/**
 * Where the context bar may show added time, and in what form (ADR-0698 §8, #2531).
 *
 * Pure — pathname in, behavior out — so the two rules it encodes are unit-tested
 * without mounting the shell. Both are rules about *what else is on the user's screen*,
 * which is exactly the kind of judgement a renderer must not make ad hoc.
 */

/**
 * Views that already carry the deterministic CPM finish on screen.
 *
 * Schedule qualifies through the dashed CPM reference chip #2426 added to the forecast
 * row. That is the whole precondition for showing a bare `+11d`: a signed delta whose
 * baseline is not visible is unverifiable, and the natural wrong guess about what it is
 * measured against makes a correct figure look like a bug. Everywhere else the strip
 * must state the pair or say nothing.
 */
const BASELINE_ON_SCREEN_VIEWS = new Set(['schedule']);

/**
 * Views that render added time themselves.
 *
 * Overview mounts `AddedTimeCard`, so a strip segment there would be the same value
 * twice on one screen — the duplication rule 284 exists to stop. Suppression is total:
 * neither the inline fragment nor the popover row renders.
 */
const ADDED_TIME_OWNED_VIEWS = new Set(['overview']);

export type AddedTimeChipContext =
  | { suppressed: true }
  | { suppressed: false; baselineOnScreen: boolean };

/**
 * Resolve the added-time context-bar behavior for a route.
 *
 * Suppressed off any project route (there is no project premium to speak of) and on
 * the views that own the value themselves. Settings routes never reach here —
 * `HealthCluster` already returns `null` on them (rule 123) — but they resolve to
 * suppressed anyway, so the function is safe to call from anywhere.
 */
export function addedTimeChipContext(pathname: string): AddedTimeChipContext {
  const view = projectViewSegment(pathname);
  if (view === null || ADDED_TIME_OWNED_VIEWS.has(view) || view === 'settings') {
    return { suppressed: true };
  }
  return { suppressed: false, baselineOnScreen: BASELINE_ON_SCREEN_VIEWS.has(view) };
}
