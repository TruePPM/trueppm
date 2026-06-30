/**
 * Pure geometry for the schedule print surface's bars and dependency arrows
 * (ADR-0188, issue 1436).
 *
 * React-free so the date→pixel bar placement and the FS connector path are
 * unit-testable in isolation (`scheduleArrowGeometry.test.ts`). The print surface
 * draws the FULL content extent at origin 0 — there is NO `scrollLeft` term (the
 * live canvas offsets every draw by scroll; the static print surface never does).
 * All X math goes through the engine's shared `dateToLeft` / `dateToRight`
 * helpers so bar, milestone, gridline, and arrow positions come from a single
 * source of geometry truth (ADR-0188 geometry-reuse contract).
 *
 * The connector here is the foundation scaffold: a 3-segment orthogonal FS path
 * (source right edge → vertical channel → target left edge). Dense-graph
 * orthogonal routing with channel stagger is issues 1437/1440; this module owns the
 * stable endpoint contract those build on.
 */
import { dateToLeft, dateToRight, type GanttScaleData } from '../engine';
import type { SchedulePrintRow } from './schedulePrintData';

/** Half-diagonal of a milestone diamond, so arrows anchor on its outer vertex. */
export const MILESTONE_HALF_PX = 7;

/** Horizontal stub length out of the source / into the target, in px. */
export const CONNECTOR_STUB_PX = 10;

/** A bar's horizontal extent in chart-local pixels (scrollLeft is never applied). */
export interface BarExtent {
  left: number;
  right: number;
}

/** An arrow anchor box: the connect points on a row's bar at a given row Y. */
export interface BarBox {
  left: number;
  right: number;
  centerY: number;
}

/**
 * Horizontal extent of a row's bar. A milestone (start === finish, drawn as a
 * diamond) is a point widened to its diamond half-diagonal; a normal bar runs
 * from `dateToLeft(start)` to the inclusive-finish right edge `dateToRight(finish)`.
 * Returns a zero-width extent at x=0 for an undated row.
 */
export function barExtent(row: SchedulePrintRow, scales: GanttScaleData): BarExtent {
  if (!row.start) return { left: 0, right: 0 };
  const left = dateToLeft(row.start, scales);
  if (row.isMilestone) {
    return { left: left - MILESTONE_HALF_PX, right: left + MILESTONE_HALF_PX };
  }
  const right = row.finish ? dateToRight(row.finish, scales) : left;
  return { left, right };
}

/** Build the arrow anchor box for a row at a given row-center Y. */
export function barBox(row: SchedulePrintRow, rowCenterY: number, scales: GanttScaleData): BarBox {
  const { left, right } = barExtent(row, scales);
  return { left, right, centerY: rowCenterY };
}

/**
 * SVG path for a Finish-to-Start connector: out of the source bar's right edge,
 * along a vertical channel, into the target bar's left edge. The path always
 * begins at the source right-edge center and ends at the target left-edge center
 * (the stable endpoint contract). When the target starts well to the right of the
 * source finish the channel sits midway; otherwise it routes around with the stub.
 */
export function fsConnectorPath(from: BarBox, to: BarBox): string {
  const x1 = from.right;
  const y1 = from.centerY;
  const x2 = to.left;
  const y2 = to.centerY;
  // Vertical channel X: midpoint when there is forward slack, else a stub past
  // the source so the path turns cleanly rather than back-tracking through bars.
  const channelX = x2 - CONNECTOR_STUB_PX > x1 ? (x1 + x2) / 2 : x1 + CONNECTOR_STUB_PX;
  return [
    `M ${round(x1)} ${round(y1)}`,
    `L ${round(channelX)} ${round(y1)}`,
    `L ${round(channelX)} ${round(y2)}`,
    `L ${round(x2)} ${round(y2)}`,
  ].join(' ');
}

/** Round to 2dp to keep SVG path strings compact and deterministic for tests. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
