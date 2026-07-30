import { projectViewSegment } from './useLocationModel';

/**
 * Where the context bar may show added time, and in what form (ADR-0698 §8, #2531).
 *
 * Pure — pathname in, behavior out — so the two rules it encodes are unit-tested
 * without mounting the shell. Both are rules about *what else is on the user's screen*,
 * which is exactly the kind of judgement a renderer must not make ad hoc.
 */

/**
 * Views that render added time themselves, in full.
 *
 * Overview mounts `AddedTimeCard`, so anything here would be a second copy of a value
 * the screen already explains better. Suppression is total: neither the inline fragment
 * nor the popover row renders.
 */
const ADDED_TIME_OWNED_VIEWS = new Set(['overview']);

/**
 * Views that already print the *number* somewhere in the page body.
 *
 * Weaker than {@link ADDED_TIME_OWNED_VIEWS}: the inline fragment is suppressed
 * because it would duplicate what the page shows, but the popover row stays, because a
 * row the user has to open the chip to see is a reference rather than a second render
 * — and it carries the two operational states (`needs estimates`, a stamped stale
 * read) that `ScheduleForecastBar` structurally cannot say.
 */
const DELTA_ON_SCREEN_VIEWS = new Set(['schedule']);

export type AddedTimeChipContext =
  | { suppressed: true }
  | {
      suppressed: false;
      /** Whether the inline chip fragment may render at all. */
      fragment: boolean;
      /** Whether a bare, unqualified day count would be verifiable here. */
      baselineOnScreen: boolean;
    };

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
  return {
    suppressed: false,
    fragment: !DELTA_ON_SCREEN_VIEWS.has(view),
    // No view qualifies, and deliberately so. The precondition for a bare `+11d` is that
    // the reader can see what it is measured against; Schedule was the obvious candidate,
    // through the dashed CPM reference chip #2426 put in the forecast row. But the
    // component that renders that chip — `ScheduleForecastBar` — renders
    // `P80: Nov 4 (+11d)` immediately beside it, from the same `delta_vs_cpm` the premium
    // is derived from. So the one surface that made a bare number legible was the one
    // surface already printing it, and a fragment there would be the same value twice on
    // one screen with nothing saying which is authoritative (rule 284, rule 291).
    //
    // This was an empty `BASELINE_ON_SCREEN_VIEWS` set kept as a carrier for that
    // rationale; a collection that can only be empty is a predicate that cannot fire and
    // reads the same as one someone forgot to populate (`typescript:S4158`, #2566), so the
    // rule lives in prose and the value is the constant it always was. The rule itself is
    // still the right one — it simply has no true case in this product today. A future
    // surface that shows the CPM finish *without* its delta is what turns this back into
    // a per-view test.
    baselineOnScreen: false,
  };
}
