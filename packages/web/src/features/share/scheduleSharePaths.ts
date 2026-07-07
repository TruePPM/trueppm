import type { PublicScheduleDependency } from './scheduleShareApi';

/**
 * Dependency-arrow geometry for the public read-only schedule viewer (#1684).
 *
 * The public page is a lightweight DOM/SVG renderer, NOT the canvas Gantt engine,
 * so it cannot reuse `GanttRenderer`'s Manhattan router. This module computes a
 * simple orthogonal (3-segment) connector per dependency edge — collision-avoiding
 * routing is deliberately out of scope for the read-only external view. Kept pure
 * (no DOM, no React) so the anchoring math is unit-testable without a measured
 * layout. Arrow color is charcoal at the call site (rule 75).
 */

/** Where a task's bar sits: horizontal edges as % of the timeline, plus its row. */
export interface DepAnchor {
  /** Bar start (left edge) as a percentage 0..100 of the timeline width, or null if unscheduled. */
  startPct: number | null;
  /** Bar finish (right edge) as a percentage 0..100, or null if unscheduled. */
  endPct: number | null;
  /** Zero-based index of the task's row within the placed list. */
  rowIndex: number;
}

/** One drawable dependency: an SVG path plus its arrowhead polygon points. */
export interface DepSegment {
  key: string;
  /** SVG path `d` for the orthogonal connector (in px). */
  d: string;
  /** SVG polygon `points` for the arrowhead at the successor endpoint (in px). */
  arrow: string;
}

const EXIT_STUB = 8; // px the connector runs straight out of its source edge
const ARROW = 5; // px arrowhead half-extent

/** Round to 1 decimal so path strings stay compact. */
function r(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Build the SVG connector for each dependency edge.
 *
 * Anchoring follows the four dependency types by reading the two-character
 * `dep_type` (`FS`/`SS`/`FF`/`SF`): the first char picks the predecessor edge
 * (F→finish, S→start), the second picks the successor edge. Edges whose endpoint
 * is unscheduled, truncated away, or otherwise missing from `anchors` are skipped
 * so no dangling arrow is drawn. Returns `[]` until the timeline width is measured
 * (`width <= 0`), so the layer renders nothing during the first paint.
 *
 * @param anchors Map of `short_id` → bar geometry for every placed task.
 * @param deps Dependency edges from the public projection.
 * @param width Measured timeline width in px.
 * @param rowHeight Fixed per-row height in px.
 */
export function buildDependencyPaths(
  anchors: Map<string, DepAnchor>,
  deps: readonly PublicScheduleDependency[],
  width: number,
  rowHeight: number,
): DepSegment[] {
  if (width <= 0) return [];
  const out: DepSegment[] = [];
  for (const dep of deps) {
    const pred = anchors.get(dep.predecessor_short_id);
    const succ = anchors.get(dep.successor_short_id);
    if (!pred || !succ) continue;

    const type = (dep.dep_type || 'FS').toUpperCase();
    const srcFinish = type[0] !== 'S'; // FS/FF exit the finish edge; SS/SF the start edge
    const tgtFinish = type[1] === 'F'; // FF/SF enter the finish edge; FS/SS the start edge

    const srcPct = srcFinish ? pred.endPct : pred.startPct;
    const tgtPct = tgtFinish ? succ.endPct : succ.startPct;
    if (srcPct == null || tgtPct == null) continue;

    const sx = (srcPct / 100) * width;
    const tx = (tgtPct / 100) * width;
    const sy = pred.rowIndex * rowHeight + rowHeight / 2;
    const ty = succ.rowIndex * rowHeight + rowHeight / 2;

    // Exit stub out of the source edge, drop to the target row, run in horizontally.
    const ex = sx + EXIT_STUB * (srcFinish ? 1 : -1);
    const d = `M ${r(sx)} ${r(sy)} H ${r(ex)} V ${r(ty)} H ${r(tx)}`;

    // Arrowhead points along the final horizontal run (ex → tx).
    const dir = tx >= ex ? 1 : -1;
    const ax = tx - ARROW * dir;
    const arrow = `${r(tx)},${r(ty)} ${r(ax)},${r(ty - ARROW)} ${r(ax)},${r(ty + ARROW)}`;

    out.push({
      key: `${dep.predecessor_short_id}->${dep.successor_short_id}:${type}`,
      d,
      arrow,
    });
  }
  return out;
}
