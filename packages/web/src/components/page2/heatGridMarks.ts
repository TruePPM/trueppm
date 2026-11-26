/**
 * `HeatGrid13`'s two marks that are drawn over heat fills. Each carries its own
 * sheet-colored (`surface-1`) backing, so its contrast is mark against sheet on
 * every band rather than mark against whatever the cell is filled with.
 * `p1Tokens.test.ts` reads the pairing out of these strings.
 */
const MARK = 'pointer-events-none absolute';

/** Dashed start line on a 4px sheet strip: the dash gaps are sheet, not fill. */
export const HEAT_START_MARK = `${MARK} inset-y-0 left-0 w-1 border-l-2 border-dashed border-p1-text-1 bg-p1-surface-1`;

/** The modeled seat: a box on each cell, with a 2px sheet gap inside it. */
export const HEAT_SEAT_MARK = `${MARK} inset-0 border-2 border-p1-text-2 outline outline-2 -outline-offset-4 outline-p1-surface-1`;
