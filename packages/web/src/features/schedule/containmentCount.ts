/**
 * How many rows a phase contains — **one** wording, for all three surfaces that
 * state it (#3025).
 *
 * The design names exactly one vocabulary: a phase's caret folds, and the row
 * states `4 inside` when open / `4 hidden` when shut. What shipped was three:
 * the caret's `aria-label` and `title` said "inside"/"hidden", the live region
 * said "N children visible"/"collapsed", and no surface said it as visible text
 * at all — so a sighted user had to hover the caret and wait out a tooltip
 * delay to learn whether a collapsed phase contained anything, which is
 * unavailable on touch and is precisely the interaction "containment survives a
 * fast visual scan" exists to remove.
 *
 * Keeping three hand-maintained phrasings for one fact is rule 316's failure
 * mode (a mirror of a derivation drifts, and a confident wrong sentence gets
 * acted on), so the phrase is derived here and imported by every stater: the
 * visible chip, the caret's accessible name, and `formatToggleAnnouncement`.
 *
 * "inside" and "hidden" are adjectives, not nouns — which is why the design
 * chose them and why there is no plural branch. `1 inside` reads correctly.
 */

/**
 * The containment phrase for a row, or `null` when there is nothing to state.
 *
 * `null` rather than `"0 inside"` so all three call sites branch identically: a
 * row with no children says nothing at all, instead of announcing an emptiness
 * every leaf in the plan shares.
 *
 * @param childCount Structural children of the row.
 * @param isExpanded Whether those children are currently rendered.
 * @returns e.g. `"4 inside"`, `"4 hidden"`, or `null`.
 */
export function formatContainmentCount(childCount: number, isExpanded: boolean): string | null {
  if (childCount <= 0) return null;
  return `${childCount} ${isExpanded ? 'inside' : 'hidden'}`;
}
