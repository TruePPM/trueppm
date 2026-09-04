import type { FocusMode } from './useScheduleFocus';

/**
 * Which teaching surface the Schedule canvas column renders — web rule 363
 * (#3134).
 *
 * ## The finding
 *
 * On a build-mode, edit-rights, row-focused Schedule three surfaces drew at
 * once: `ScheduleCoachBar` and `BuildModeHintStrip` in the band between the
 * outline and the forecast bar, and `ScheduleInsertTargetStatement` in the
 * toolbar.
 *
 * The first two share a slot, which is worth stating precisely because the
 * issue and the design both described the coach bar as sitting *above* the
 * outline and it does not. Measured at 1920×1080 with two rows: coach bar at
 * `y=978` (29px), hint strip at `y=979` (28px). Before this change they queued
 * one under the other for ~57px of stacked hint bars directly beneath the plan.
 * So the arbitration below is not a tidying preference — the two were competing
 * for literally the same pixels.
 *
 * The count was right about the pixels and wrong about the kinds. The insert
 * statement is a **readout** — its text is a pure function of the current
 * insert target, it teaches nothing, and it is `+ Item`'s own
 * `aria-describedby` node (rule 316). Rule 363 clause 1 exempts it, which
 * leaves two teachers, not three.
 *
 * ## Why the two are arbitrated here rather than deduplicated
 *
 * The design's own proposal was to delete the strip on the grounds that its
 * content is a static duplicate of the coach bar's third line, so "no string is
 * lost". Checked against the component, that is false: the strip carries four
 * hint sets, and three of them (`NoSelection`, `CellEdit`, `SELECTION_HINTS`)
 * have no coach-bar counterpart at all. `SELECTION_HINTS` is the only place the
 * group chord is advertised at the moment a multi-row selection exists (#2955),
 * and it is load-bearing precisely because `displayOptions.structureButtons` is
 * off by default — nothing else names that chord when it starts meaning
 * something.
 *
 * The mirror-image proposal — drop the coach bar's row-controls line as the
 * duplicated one — is wrong in the other direction and for a checkable reason:
 * the row-controls line is the coach bar's *only* line with no strip
 * counterpart. The strings that genuinely appear on both surfaces are the
 * indent chord (coach line 1 / strip `RowFocused`) and the group chord (coach
 * line 2 / strip `SELECTION_HINTS`). Deleting the row-controls line would
 * remove the coach bar's stated reason to exist — discovery was hover-dependent
 * and a user who never hovered a row never learned the row controls were there
 * (#2959) — and leave behind only the two lines that *are* duplicated.
 *
 * ## What the rule yields instead
 *
 * Clause 3 decides it without deleting anything. The strip is anchored to focus
 * state and selection size; the coach bar is anchored to the venue (build mode
 * is on). The strip's anchor is strictly narrower, so wherever both would
 * render the strip wins and the coach bar stands down.
 *
 * "Wherever both would render" is exactly `focusMode !== 'NoSelection'`, so the
 * two predicates below partition the focus space and **cannot both be true**.
 * That is a stronger property than a hand-scoped suppression term, and it is
 * what `teachingSurfaces.test.ts` asserts exhaustively.
 *
 * The result is one band with two contents rather than two bands competing for
 * one slot: the venue-anchored coach while the outline is idle, the
 * focus-anchored strip once the planner engages. Neither surface loses a
 * string, and because it is one band it has to draw one frame — which is why
 * the coach bar's rule moved to `border-t` to match the strip's.
 */

export interface CanvasTeachingInput {
  /** Build mode is on — the venue both surfaces are scoped to. */
  buildModeActive: boolean;
  /** This reader may author. A teacher for a mutation nobody is offered is noise (rule 302). */
  hasEditRights: boolean;
  /** `displayOptions.coach` — the per-person dismiss/restore state (#2959). */
  coachEnabled: boolean;
  focusMode: FocusMode;
  /**
   * Rows the canvas is actually drawing.
   *
   * Deliberately the *visible* count and not `allTasks.length`: a filter that
   * hides every row leaves the canvas showing the same empty surface, and the
   * coach bar's three lessons — indent an item, select rows to group, hover a
   * row — are equally unperformable either way. Clause 2 asks whether the lesson
   * can be acted on here and now, and this is the number that answers it.
   */
  visibleRowCount: number;
}

/**
 * The coach bar (`ScheduleCoachBar`) — venue-anchored, teaches the outline.
 *
 * Two terms beyond the shipped predicate:
 *
 * - `focusMode === 'NoSelection'` — clause 3. The strip's anchor is narrower
 *   wherever both could draw, so the coach bar yields the column to it. This is
 *   also the only moment its lessons are the *next* thing the planner needs
 *   rather than a commentary on what they are already doing.
 * - `visibleRowCount > 0` — clause 2 and the `T4` term. None of the coach bar's
 *   three lessons can be performed with no rows: there is nothing to indent,
 *   nothing to select, nothing to hover. And a narrower-anchored teacher is
 *   already up for the one act that IS available — `BlankOutlineDraftRow`, the
 *   live row holding the caret (#2733), with `BlankProjectCanvas` offering the
 *   bulk fill routes beside it. Name the draft row rather than the canvas when
 *   checking this premise: the canvas half is a horizon plus an import aside
 *   and teaches no outline act.
 *
 * `coachEnabled` is untouched, and so is the dismiss → restore pairing it
 * carries (#2959): suppression here is a render condition, never a write. A
 * planner who dismissed the bar still restores it from Display ▸ Outline ▸
 * How-to bar, and a planner who never dismissed it still has it when they next
 * clear their selection. Retiring the bar for the moment must not read as
 * dismissing it, which is why this function may not touch the stored option.
 */
export function shouldRenderCoachBar({
  buildModeActive,
  hasEditRights,
  coachEnabled,
  focusMode,
  visibleRowCount,
}: CanvasTeachingInput): boolean {
  return (
    buildModeActive &&
    hasEditRights &&
    coachEnabled &&
    focusMode === 'NoSelection' &&
    visibleRowCount > 0
  );
}

/**
 * The hint strip (`BuildModeHintStrip`) — focus- and selection-anchored.
 *
 * Unchanged from what shipped (#1250, rule 194): mounted only while the planner
 * is engaged, so the idle Schedule reclaims the band for `ScheduleForecastBar`.
 * It is restated here rather than left inline so that the one-per-column
 * property is a claim about two functions in one file, provable by enumeration,
 * instead of a claim about two JSX conditions 400 lines apart in a 6,000-line
 * component.
 *
 * Note what is deliberately *not* added: a `visibleRowCount` term. A filter can
 * hide the focused row without clearing the focus state, and taking the strip
 * away at that moment would strand a planner mid-edit with no key hints. The
 * one-per-column property does not need the term — the focus-mode partition
 * below already delivers it.
 *
 * `hasEditRights` is absent for a DIFFERENT reason, and the two must not be read
 * as one decision. #3231 settled the call this function deliberately did not
 * make, and settled it in favor of a **read-appropriate hint set** rather than
 * withholding the strip: the `? All shortcuts` route is the strip's only job
 * that survives without rights, and taking the band away would take that route
 * with it while leaving a reader who arrows the outline with no key hints at
 * all. So the rights term lives in `BuildModeHintStrip`'s *content*
 * (`READER_HINTS`) and not in this predicate, which stays a pure statement about
 * which surface owns the column.
 *
 * Read that as a scope boundary, not an omission: rule 302 is satisfied by the
 * strip teaching only acts the reader can perform, which is a question about
 * what it says. Whether it renders at all is a question about the column, and
 * the answer to that one does not depend on rights.
 */
export function shouldRenderHintStrip({
  buildModeActive,
  focusMode,
}: CanvasTeachingInput): boolean {
  return buildModeActive && focusMode !== 'NoSelection';
}
