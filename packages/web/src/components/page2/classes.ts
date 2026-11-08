/**
 * Shared class recipes for the shell v2 Pass 2 page kit (rule 439).
 *
 * The kit's components and the shell's own chrome read these so the 44px
 * target and the focus ring are written once. A page that needs either one
 * imports it from here rather than re-typing the utilities.
 */

/**
 * A 44px hit area around a control shorter than 44px (rules 5, 330): SIZED,
 * never inset. Only valid where no ancestor clips overflow — inside a scroller
 * that clips, make the box itself 44px instead.
 */
export const HIT_44 =
  "relative before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-full before:min-w-[44px] before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

/**
 * The Pass 2 focus ring: 2px, offset 2px from the control, offset gap painted
 * in the sheet color so it reads on `surface-1` in both themes (rule 4's
 * shape, `--p1-focus` for its color, which clears 3:1 on the sheet — pinned by
 * `p1Tokens.test.ts`).
 */
export const FOCUS_RING =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus focus-visible:ring-offset-2 focus-visible:ring-offset-p1-surface-1';
