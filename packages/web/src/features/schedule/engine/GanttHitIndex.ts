/**
 * Spatial hit-test index for the canvas Gantt renderer.
 *
 * Pure data structure — no React, no DOM, no Canvas 2D. Rebuilt on every
 * data change or zoom change (O(n), < 1ms for 2,000 tasks) and queried on
 * every pointer event.
 *
 * Design rules enforced:
 * - Rule 63: spatial index, not per-pixel color mapping
 * - Rule 64: resize handle and link-dot zones expand on touch
 * - Rule 66: touch-action: none on canvas elements (enforced in CanvasScheduleTimeline)
 */

import type { Task } from '@/types';
import type { GanttScaleData } from './GanttScaleData';
import { dateToLeft, dateToRight } from './GanttScaleData';
import { CHART_HEADER_HEIGHT, ROW_HEIGHT, BAR_TOP_OFFSET, BAR_HEIGHT } from '../scheduleConstants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Re-exported, not redeclared (#2997). `ROW_HEIGHT` and `BAR_TOP_OFFSET` are
 * pointer-dependent **live bindings** owned by `scheduleConstants`; a second
 * `= 28` here would put the hit index out of step with what the renderer paints,
 * and a hit index that disagrees with the paint does not look broken — taps just
 * land on the wrong task. Re-exporting keeps every existing importer of these
 * names working while leaving exactly one place the number is chosen.
 */
export { ROW_HEIGHT, BAR_TOP_OFFSET, BAR_HEIGHT };

/** Web rule 5 / WCAG 2.5.5 touch-target floor, in logical px. */
const TOUCH_TARGET_MIN = 44;
/** Width of the resize handle in logical px (non-touch). */
const RESIZE_HANDLE_WIDTH = 16;
/** How many px the resize zone extends past the right edge. */
const RESIZE_RIGHT_OVERHANG = 8;
/** Right edge of the link-dot zone. */
const LINK_DOT_RIGHT = 16;

/**
 * Center of the link-dot zone, as an offset from `barRight` — the x the visible
 * link handle is drawn at (#2702).
 *
 * Exported so the renderer cannot drift from the hit zone. A handle painted even a
 * few px off its own hotspot is worse than no handle: the user aims at what they can
 * see, misses, and starts a *move* drag instead of a link, silently rescheduling the
 * task. Both must move together or neither should.
 */
export const LINK_DOT_CENTER_OFFSET = (RESIZE_RIGHT_OVERHANG + LINK_DOT_RIGHT) / 2;
/**
 * Minimum bar-body width (logical px) preserved for the drag-to-move zone.
 * A bar narrower than RESIZE_HANDLE_WIDTH (a 1–2 day task at Week zoom, or any
 * short task at Month/Quarter) would otherwise have its entire body swallowed by
 * the resize handle — every pointer hit resolves to `resize` and a drag silently
 * changes DURATION instead of moving the task (#2185). Clamping the handle's
 * inner edge to keep at least this much grabbable body confines resize to the
 * right overhang on short bars while leaving move reachable.
 */
const MIN_BODY_WIDTH = 8;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HitZoneType = 'bar' | 'resize' | 'link-dot';

export interface HitZone {
  taskId: string;
  rowIndex: number;
  barLeft: number;   // canvas-origin x
  barRight: number;  // canvas-origin x
  barTop: number;    // canvas-origin y (rowIndex * ROW_HEIGHT + BAR_TOP_OFFSET)
  barBottom: number;
  type: HitZoneType;
}

export interface HitIndex {
  query(canvasX: number, canvasY: number, isTouch: boolean): HitZone | null;
  /**
   * Bar geometry for a row, or null when the row has no bar (unscheduled task).
   *
   * Exists so the renderer can place the visible link handle (#2702) on the exact
   * geometry the hit test uses, rather than recomputing `dateToRight` and risking a
   * silent divergence between what is drawn and what is clickable.
   */
  rowGeometry(rowIndex: number): RowGeometry | null;
}

/** Bar geometry for one row, as the hit index computed it. */
export interface RowGeometry {
  taskId: string;
  barLeft: number;
  barRight: number;
  barTop: number;
  barBottom: number;
  isMilestone: boolean;
}

// ---------------------------------------------------------------------------
// Internal representation per row
// ---------------------------------------------------------------------------

interface RowEntry {
  taskId: string;
  rowIndex: number;
  barLeft: number;
  barRight: number;
  barTop: number;
  barBottom: number;
  rowTop: number;
  isMilestone: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class HitIndexImpl implements HitIndex {
  // Rows sorted by barTop — allows early exit on canvasY
  private readonly _rows: RowEntry[];

  constructor(rows: RowEntry[]) {
    this._rows = rows;
  }

  query(canvasX: number, canvasY: number, isTouch: boolean): HitZone | null {
    // Hoisted once per query rather than read per row: ROW_HEIGHT is a live
    // binding (#2997) and this loop runs on every pointer event.
    const rowH = ROW_HEIGHT;
    for (const row of this._rows) {
      // Fast vertical bounds check using full row height
      if (canvasY < row.rowTop || canvasY >= row.rowTop + rowH) continue;
      const zone = hitZoneInRow(row, canvasX, canvasY, isTouch);
      if (zone) return zone;
    }

    return null;
  }

  rowGeometry(rowIndex: number): RowGeometry | null {
    // Linear scan rather than an index: `_rows` skips unscheduled tasks, so its
    // positions are not task positions, and this is called at most once per repaint.
    for (const row of this._rows) {
      if (row.rowIndex === rowIndex) {
        return {
          taskId: row.taskId,
          barLeft: row.barLeft,
          barRight: row.barRight,
          barTop: row.barTop,
          barBottom: row.barBottom,
          isMilestone: row.isMilestone,
        };
      }
    }
    return null;
  }
}

/** Inclusive 1-D containment test. */
function within(v: number, lo: number, hi: number): boolean {
  return v >= lo && v <= hi;
}

/**
 * Resolve which interactive zone of one row a point lands in, if any.
 *
 * The order below is precedence, not convenience: link-dot wins over resize,
 * which wins over the bar body, because the outer zones are the smaller targets
 * and would otherwise be unreachable.
 */
function hitZoneInRow(
  row: RowEntry,
  canvasX: number,
  canvasY: number,
  isTouch: boolean,
): HitZone | null {
  const { taskId, rowIndex, barLeft, barRight, barTop, barBottom } = row;
  const base = { taskId, rowIndex, barLeft, barRight, barTop, barBottom };

  // --- Link-dot zone: [barRight + 4, barRight + 16] x full row ---
  const linkDotLeft = barRight + RESIZE_RIGHT_OVERHANG;
  const linkDotRight = barRight + LINK_DOT_RIGHT;
  // Expand to the 44px touch floor on touch, centered in the row.
  //
  // It never actually reached 44 before #2997, and the reason is not in this
  // expression: `query()`'s outer bounds check clips every zone to its own row
  // band, so a 44px zone centered in a 28px row is silently trimmed back to 28
  // — 8px off each end — and a finger got a 28px target while the code read as
  // if it got 44. At the coarse row height the arithmetic yields an inset of
  // exactly 0, so the zone IS the row band and the clip takes nothing. That is
  // the floor being met, rather than declared.
  const linkDotTop = isTouch ? row.rowTop + (ROW_HEIGHT - TOUCH_TARGET_MIN) / 2 : barTop;
  const linkDotBottom = isTouch ? linkDotTop + TOUCH_TARGET_MIN : barBottom;
  if (within(canvasX, linkDotLeft, linkDotRight) && within(canvasY, linkDotTop, linkDotBottom)) {
    return { ...base, type: 'link-dot' };
  }

  // --- Resize handle zone (skipped for milestones) ---
  // Milestones are zero-duration diamonds — there is nothing to resize, so the
  // whole glyph must stay draggable-to-move (#2185).
  //
  // The handle's inner edge is [barRight - 16] (mouse) / [barRight - 12]
  // (touch), but clamped so it never crosses barLeft + MIN_BODY_WIDTH: on a
  // bar narrower than the handle that keeps a grabbable body and pushes resize
  // out to the right overhang, instead of the whole bar resolving to `resize`
  // and drag-to-move silently becoming a duration change.
  const resizeInnerEdge = isTouch ? barRight - 12 : barRight - RESIZE_HANDLE_WIDTH;
  const resizeLeft = Math.min(barRight, Math.max(barLeft + MIN_BODY_WIDTH, resizeInnerEdge));
  const resizeRight = isTouch ? barRight + 8 : barRight + RESIZE_RIGHT_OVERHANG;
  if (
    !row.isMilestone &&
    within(canvasX, resizeLeft, resizeRight) &&
    within(canvasY, barTop, barBottom)
  ) {
    return { ...base, type: 'resize' };
  }

  // --- Bar body: [barLeft, resizeLeft) x bar ---
  // Milestones (no resize zone) get the full [barLeft, barRight] span.
  const bodyRight = row.isMilestone ? barRight : resizeLeft;
  if (within(canvasX, barLeft, bodyRight) && within(canvasY, barTop, barBottom)) {
    return { ...base, type: 'bar' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a spatial hit index from the current task list and scale data.
 *
 * O(n) — iterate tasks once, compute bar geometry from scales.
 * Call this whenever tasks or scales change.
 */
export function buildHitIndex(tasks: Task[], scales: GanttScaleData): HitIndex {
  const rows: RowEntry[] = [];

  // Hoisted live bindings (#2997) — the index is rebuilt on every data or zoom
  // change, so this loop is O(n) over the whole plan.
  const rowH = ROW_HEIGHT;
  const barTopOffset = BAR_TOP_OFFSET;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    // Skip unscheduled tasks — no valid bar position
    if (!task.start || !task.finish) continue;
    const barLeft = dateToLeft(task.start, scales);
    // finish is inclusive — hit zones must track the true (exclusive) edge so the
    // resize handle and link-dot sit on the visible bar edge, not a day early (#950).
    const barRight = dateToRight(task.finish, scales);
    const barTop = i * rowH + CHART_HEADER_HEIGHT + barTopOffset;
    const barBottom = barTop + BAR_HEIGHT;
    const rowTop = i * rowH + CHART_HEADER_HEIGHT;

    rows.push({
      taskId: task.id,
      rowIndex: i,
      barLeft,
      barRight,
      barTop,
      barBottom,
      rowTop,
      isMilestone: task.isMilestone,
    });
  }

  return new HitIndexImpl(rows);
}
