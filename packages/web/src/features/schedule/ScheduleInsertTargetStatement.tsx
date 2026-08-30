import {
  describeInsertTarget,
  describeInsertTargetShort,
  type InsertTarget,
} from './buildMode/insertTarget';
import type { SentenceDensity } from './toolbar/toolbarLadder';

/**
 * Stable id the `+ Item` button points `aria-describedby` at. Fixed rather than
 * generated: exactly one Schedule toolbar is mounted at a time, and the button
 * has to name the element from a different component.
 */
export const INSERT_TARGET_STATEMENT_ID = 'schedule-insert-target-statement';

export interface ScheduleInsertTargetStatementProps {
  target: InsertTarget;
  /**
   * Whether this reader may author at all. Without rights the statement is
   * ABSENT, not dimmed — web rule 302. It describes a mutation, and narrating a
   * mutation nothing offers is noise, not help.
   */
  hasEditRights: boolean;
  /**
   * How much room the fit ladder left for it (#3076).
   *
   * `none` renders the FULL sentence `sr-only` — it never unmounts. The width
   * is what ran out, not the user's need for the description, and unmounting
   * would take the `+ Item` button's own `aria-describedby` target with it
   * (rule 316(c)). A screen-reader user therefore hears the same complete
   * sentence at 1024 as at 1920; only the ink is rationed.
   */
  density?: SentenceDensity;
}

/**
 * The toolbar's "here is where my insert lands" sentence (#2957, web rule 316).
 *
 * Three deliberate choices:
 *
 * - **`sr-only`, never `hidden`.** There is no room to draw a sentence in a
 *   crowded toolbar, but "no room to draw it" is not a reason to withhold it:
 *   `display:none` takes the button's own description out of the accessibility
 *   tree along with the pixels, so a screen-reader user would lose it at every
 *   width — and the button still branches three ways on focus state down there.
 *   It stays readable to AT at all widths and becomes visible where it fits.
 *   The `min-w-` floor rides with the `max-w-` cap because a shrinkable
 *   `truncate` span in a `flex-nowrap` bar collapses to zero width and ships
 *   "present" but invisible (rule 316(c)).
 *
 *   Since #3076 the *width* decision belongs to the fit ladder (`density`)
 *   rather than to a `lg:` breakpoint. The old form branched on the viewport,
 *   which could not see the things that actually consume the bar — the rail
 *   being collapsed, the user's pins, whether this reader may author at all.
 *
 *   Since #3134 (`T5`) the description and the drawing are **separate nodes at
 *   every density**: a permanent `sr-only` full sentence, plus an `aria-hidden`
 *   rendering of whatever the ladder left room to draw. The invariant that buys
 *   is that `+ Item`'s accessible description is byte-identical at 1024 and at
 *   1920, structurally rather than by the current rungs happening to agree.
 * - **It is a READOUT, not a teaching surface** (web rule 363 clause 1). Its
 *   text is a pure function of the insert target, so it is exempt from the
 *   canvas column's one-teacher-at-a-time arbitration and renders alongside
 *   whichever teacher is up. Retiring it was never the answer to #3134: it is
 *   the one surface there that states an outcome rather than a lesson.
 * - **No `aria-live`.** The sentence changes on every arrow-key row move, so a
 *   live region would speak over the row announcement a planner is navigating
 *   by — the same reasoning that keeps `BuildModeHintStrip` silent (web rule
 *   194). `aria-describedby` on the button is the right seam instead: it is
 *   announced on focus, when someone is about to act, not on every move.
 * - **No fallback sentence.** When nothing is focused there is no row to land
 *   after, so the component renders nothing rather than inventing a claim. A
 *   sentence that describes a *different* affordance's behavior (the footer's
 *   append-at-the-end) is exactly the collapse #2957 exists to undo.
 */
export function ScheduleInsertTargetStatement({
  target,
  hasEditRights,
  density = 'full',
}: ScheduleInsertTargetStatementProps) {
  if (!hasEditRights) return null;
  const full = describeInsertTarget(target);
  if (!full) return null;
  const short = describeInsertTargetShort(target);

  // AT always hears the full sentence; only the drawn form shortens. The two
  // never disagree because both come from the same target (rule 316(a)).
  if (density === 'none') {
    return (
      <span
        id={INSERT_TARGET_STATEMENT_ID}
        data-testid="schedule-insert-target"
        data-target-kind={target.kind}
        data-density="none"
        className="sr-only"
      >
        {full}
      </span>
    );
  }

  const visible = density === 'short' ? (short ?? full) : full;
  return (
    <span
      id={INSERT_TARGET_STATEMENT_ID}
      data-testid="schedule-insert-target"
      data-target-kind={target.kind}
      data-density={density}
      className={[
        'inline-flex shrink-0 items-center truncate whitespace-nowrap',
        // The `min-w-` floor rides with the `max-w-` cap: a shrinkable
        // `truncate` span in a `flex-nowrap` bar otherwise collapses to zero
        // width and ships "present" but invisible (rule 316(c)). `shrink-0` is
        // also what makes the bar's overflow measurable at all (#3076).
        density === 'short' ? 'min-w-[5rem] max-w-[10rem]' : 'min-w-[8rem] max-w-[18rem]',
        'text-xs text-neutral-text-secondary',
      ].join(' ')}
    >
      {/* Two nodes at EVERY density, not only at `short` (#3134 `T5`).
          `+ Item` points `aria-describedby` here, and a description is computed
          from the referenced node's text — so the description is whatever this
          subtree contributes to the accessibility tree.

          Before this the split existed only in the `short` branch and the other
          two densities let one node serve both jobs. That happened to compute
          the same sentence, but only because `full` and the drawn form were the
          same string there; nothing structural said so, and the next rung the
          ladder grows would have made the description a function of viewport
          width again by simply adding a third drawn form. Splitting the roles
          unconditionally makes "the description does not change with width" a
          property of the markup rather than a coincidence of the current rungs.

          The full sentence is always real TEXT, never only an `aria-label`: an
          `aria-label` on a bare `<span>` produces no accessible name at all,
          because a generic element is name-prohibited. `aria-hidden` on the
          drawn copy is what keeps AT hearing one sentence rather than two
          (rule 171 — never both forms of one claim). */}
      <span className="sr-only">{full}</span>
      <span aria-hidden="true" className="truncate">
        {visible}
      </span>
    </span>
  );
}
