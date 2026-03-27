/** Fixed row height — must match SVAR's internal row height for scroll sync */
export const ROW_HEIGHT = 28;
/**
 * Height of the canvas timeline header (major + minor date labels).
 * Must match TaskListHeader h-7 (28px) so task-list rows align with canvas bars.
 */
export const HEADER_HEIGHT = 28;
/** WBS indent per level in pixels */
export const WBS_INDENT = 16;
/**
 * Height of the Monte Carlo confidence row below the split pane.
 * 44px — meets touch-target minimums; outside the virtualizer so scroll sync
 * does not apply (not 28px like task rows).
 */
export const MC_ROW_HEIGHT = 44;
