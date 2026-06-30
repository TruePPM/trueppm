/**
 * Shared board grid geometry (issue 1458 / issue 1459, ADR-0192 Part 1 & 2).
 *
 * The board's three vertically aligned grids — the sticky column header, each
 * phase-milestone rail, and each phase lane — must use an identical CSS grid
 * track template so their columns stay pixel-aligned under horizontal scroll.
 * They all build that template from this single helper so the geometry can
 * never drift between surfaces (the same discipline as `wip.ts` for WIP bands).
 */
import type { TaskStatus } from '@/types';

/**
 * Width (px) of a column folded to a stub. A collapsed column occupies this
 * fixed track instead of a full `--board-col-w` track so the header stub, the
 * milestone rail, and every lane line up on the same narrow column.
 */
export const BOARD_STUB_W = 34;

/**
 * Build the CSS `grid-template-columns` value for a board grid.
 *
 * The first track is the sticky-left phase sidebar (`--board-phase-col`). Each
 * status column is either a fixed `--board-col-w` track (so the board overflows
 * its scroll container horizontally rather than squishing columns) or a narrow
 * `BOARD_STUB_W` track when the column is collapsed.
 *
 * @param columns The visible board columns, in display order.
 * @param collapsedColumns Statuses currently folded to stubs.
 * @returns A `grid-template-columns` string.
 */
export function boardGridTemplate(
  columns: { status: TaskStatus }[],
  collapsedColumns: Set<TaskStatus>,
): string {
  const tracks = columns
    .map((c) =>
      collapsedColumns.has(c.status) ? `${BOARD_STUB_W}px` : 'var(--board-col-w,272px)',
    )
    .join(' ');
  return `var(--board-phase-col,188px) ${tracks}`;
}
