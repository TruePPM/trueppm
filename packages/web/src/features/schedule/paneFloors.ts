/**
 * The Schedule split pane's width floors, and the one clamp that enforces them.
 *
 * Deliberately its own module with **no imports**. These constants are asserted
 * from an E2E spec as well as from unit tests, and `packages/web/e2e` compiles
 * under `tsconfig.e2e.json`, which does not carry the vite client types — so
 * importing them from `ScheduleView` pulls that whole module graph into a
 * project where `import.meta.env` does not type-check. Repeating the numbers in
 * the spec instead would keep asserting the old floor the day somebody changes
 * the real one, which is the failure this file exists to prevent.
 */

/** Floor on the bar track's width — below this the timeline stops being one. */
export const MIN_BAR_TRACK = 320;

/** Floor on the outline's rendered width, once the pane makes it yield. */
export const MIN_OUTLINE_WIDTH = 240;

/**
 * `PanelSplitter`'s own width — `w-1`, and `flex-shrink-0` like the outline, so
 * it comes off the pane before the track does. Small enough to look like a
 * rounding error in a screenshot and big enough to leave the track 4px short of
 * the floor it was promised, which is exactly how it was found.
 */
export const SPLITTER_WIDTH = 4;

/**
 * How wide the outline may RENDER, which is not how wide its columns are (#3279).
 *
 * `maxTaskWidthFor` is a ceiling on *growing* the name column, and it deliberately
 * never reaches backwards past the width the user already holds. That leaves the
 * shrinking direction unowned: the outline paints at `totalWidth` with
 * `flex-shrink-0`, the canvas beside it is `flex-1 min-w-0`, so every pixel the
 * pane loses comes out of the bar track until there is none left. `MIN_BAR_TRACK`
 * was declared for exactly this and enforced nowhere — at 768px the canvas was
 * already down to 25px on a pane that had never been narrower than the outline's
 * 738px default. A 64px rail where there had been 0px took the same arithmetic to
 * 0px, which is the only reason a test finally saw it. 25px was not a passing
 * state; `toBeVisible()` just cannot tell 25px from usable (the #2974 lesson,
 * rule 343).
 *
 * So the bar track takes its floor first and the outline renders into what is
 * left, clipping its rightmost columns rather than the timeline losing the track
 * that makes it one. This is a RENDER clamp: no persisted column width changes,
 * nothing is announced to assistive tech as a new bound, and widening the window
 * restores the user's outline exactly. `MIN_OUTLINE_WIDTH` keeps WBS + a readable
 * name on screen so the clamp can never trade one useless pane for another.
 */
export function outlinePaneWidthFor(
  containerWidth: number,
  outlineWidth: number,
  reservedWidth = 0,
): number {
  // Not laid out yet (first paint, jsdom) — render what the columns ask for
  // rather than clamping against a zero that means "unknown", not "no room".
  if (containerWidth <= 0) return outlineWidth;
  // `reservedWidth` is every OTHER `flex-shrink-0` thing sharing the row, which
  // today is the splitter. Counting only the outline and the track would leave
  // the track short by exactly whatever was forgotten.
  const room = containerWidth - MIN_BAR_TRACK - reservedWidth;
  if (room >= outlineWidth) return outlineWidth;
  return Math.max(MIN_OUTLINE_WIDTH, room);
}
