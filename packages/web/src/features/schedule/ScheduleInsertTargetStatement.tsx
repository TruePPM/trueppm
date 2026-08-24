import { describeInsertTarget, type InsertTarget } from './buildMode/insertTarget';

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
}

/**
 * The toolbar's "here is where my insert lands" sentence (#2957, web rule 316).
 *
 * Three deliberate choices:
 *
 * - **`sr-only` below `lg`, never `hidden`.** There is no room to draw a
 *   sentence in the 768–1023px toolbar, but "no room to draw it" is not a
 *   reason to withhold it: `display:none` takes the button's own description
 *   out of the accessibility tree along with the pixels, so a screen-reader
 *   user would lose it at every width — and the button still branches three
 *   ways on focus state down there. It stays readable to AT at all widths and
 *   becomes visible where it fits. The `min-w-` floor rides with the `max-w-`
 *   cap because a shrinkable `truncate` span in a `flex-nowrap` bar collapses
 *   to zero width and ships "present" but invisible (rule 316(c)).
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
}: ScheduleInsertTargetStatementProps) {
  if (!hasEditRights) return null;
  const statement = describeInsertTarget(target);
  if (!statement) return null;
  return (
    <span
      id={INSERT_TARGET_STATEMENT_ID}
      data-testid="schedule-insert-target"
      data-target-kind={target.kind}
      className="sr-only lg:not-sr-only lg:inline-flex lg:items-center
        lg:min-w-[8rem] lg:max-w-[18rem] lg:truncate lg:whitespace-nowrap
        text-xs text-neutral-text-secondary"
    >
      {statement}
    </span>
  );
}
