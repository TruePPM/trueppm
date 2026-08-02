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
import { HEADER_HEIGHT } from '../scheduleConstants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ROW_HEIGHT = 28;
export const BAR_TOP_OFFSET = 5;
export const BAR_HEIGHT = 18;

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
    for (const row of this._rows) {
      // Fast vertical bounds check using full row height
      if (canvasY < row.rowTop || canvasY >= row.rowTop + ROW_HEIGHT) continue;
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
  // Expand to 44px tall on touch (centered on bar)
  const linkDotTop = isTouch ? row.rowTop + (ROW_HEIGHT - 44) / 2 : barTop;
  const linkDotBottom = isTouch ? linkDotTop + 44 : barBottom;
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

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    // Skip unscheduled tasks — no valid bar position
    if (!task.start || !task.finish) continue;
    const barLeft = dateToLeft(task.start, scales);
    // finish is inclusive — hit zones must track the true (exclusive) edge so the
    // resize handle and link-dot sit on the visible bar edge, not a day early (#950).
    const barRight = dateToRight(task.finish, scales);
    const barTop = i * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;
    const barBottom = barTop + BAR_HEIGHT;
    const rowTop = i * ROW_HEIGHT + HEADER_HEIGHT;

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
