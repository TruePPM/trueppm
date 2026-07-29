/**
 * The A2 width budget for the added-time fragment on the health chip (ADR-0698 §9).
 *
 * **Measurement-free by construction** — no `offsetWidth`, no `ResizeObserver`, no
 * `getBoundingClientRect`. That is a design constraint, not a shortcut. A measuring
 * budget would read the very container whose `min-width` / `overflow-x` rules #2533
 * owns, and the two would fight: the fragment would size itself against a box that is
 * simultaneously being told how to shrink. A declared budget also makes the rule a
 * pure function, which is what lets the "never un-qualified" invariant be tested at
 * every width instead of at whatever width a test renderer happens to simulate.
 * `truncateWbsPath` is the same pattern already in the tree.
 *
 * The rule it encodes is A1 and A2 fused: an unqualified number is only legible where
 * the baseline is already on screen, so where it is not, the *only* alternatives are
 * the full pair or nothing. Degrading a pair to a bare number to make it fit is the
 * one outcome forbidden outright — it would trade "no pointer" for "a delta the reader
 * cannot check", which is worse.
 */

/** Header `px-3` (24) + the rail-reopen button `w-8` (32) + three `gap-2` (24). */
const BAR_FIXED_CHROME_PX = 80;

/** `Program › Project › Leaf` at a readable minimum. The only element in the bar that
 *  can absorb pressure, so the budget reserves it rather than eating into it. */
const LOCATION_SWITCHER_MIN_PX = 320;

/** Measured per-control cost of a right-cluster sibling at 12.5px mono, incl. its gap. */
const SIBLING_PX = 94;

/** The health chip itself: dot (8) + worst-state word + caret + `px-3`. */
const CHIP_BASE_PX = 104;

/** The existing `P80 {date}` fragment, when the methodology cluster has a forecast. */
const P80_FRAGMENT_PX = 76;

/** `+11d` / `−4d` / `No added time`, plus its separator and the `Added` label. */
const ADDED_TIME_NUMBER_PX = 105;

/** `+11d vs Oct 24`, plus its separator and the `Added` label. */
const ADDED_TIME_QUALIFIED_PX = 230;

/**
 * Worst-case right-cluster sibling count, and what the production call site passes.
 *
 * Every sibling self-gates internally — `TimerChip` only while a timer runs,
 * `TaskRunIndicator` only when runs are active, `PresenceAvatarStack` only when
 * someone else is online, `MethodologyIndicator` only on a collapsed rail — so the
 * true count changes under the user without a re-render of this chip, and observing it
 * would require the measurement this module refuses. Budgeting for the worst case
 * makes the fragment render *predictably*: a fragment that fits when a colleague logs
 * off and pushes the breadcrumb when they log back in is worse than one that is
 * consistently absent at that width.
 */
export const RIGHT_CLUSTER_MAX_SIBLINGS = 5;

export interface AddedTimeChipFitInput {
  viewportWidth: number;
  /** Right-cluster controls competing for the same row. */
  siblingCount: number;
  /** True where the CPM baseline is already rendered (Schedule, via #2426). */
  baselineOnScreen: boolean;
  /** Whether the chip is also carrying its `P80 {date}` fragment. */
  hasP80Fragment: boolean;
}

/** The fragment form that fits, or `null` when the honest answer is to render none. */
export type AddedTimeChipForm = 'number' | 'qualified' | null;

/**
 * Which added-time fragment form the bar can afford at this width.
 *
 * Returns `'number'` only when the baseline is on screen — where it is not,
 * `'qualified'` or `null` are the sole outcomes, and that is the invariant callers and
 * tests hold this function to. Below `md` the caller never consults it: the fragment is
 * breakpoint-gated off entirely and the popover row carries the value instead.
 */
export function addedTimeChipForm(input: AddedTimeChipFitInput): AddedTimeChipForm {
  const available =
    input.viewportWidth -
    BAR_FIXED_CHROME_PX -
    LOCATION_SWITCHER_MIN_PX -
    input.siblingCount * SIBLING_PX -
    CHIP_BASE_PX -
    (input.hasP80Fragment ? P80_FRAGMENT_PX : 0);

  if (input.baselineOnScreen) {
    return available >= ADDED_TIME_NUMBER_PX ? 'number' : null;
  }
  // No baseline on screen: the pair is the only readable form, so it is fit-or-drop.
  return available >= ADDED_TIME_QUALIFIED_PX ? 'qualified' : null;
}
