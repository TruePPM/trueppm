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
import { dateToLeft } from './GanttScaleData';
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

      const { taskId, rowIndex, barLeft, barRight, barTop, barBottom } = row;

      // --- Link-dot zone: [barRight + 4, barRight + 16] x full row ---
      const linkDotLeft = barRight + RESIZE_RIGHT_OVERHANG;
      const linkDotRight = barRight + LINK_DOT_RIGHT;
      // Expand to 44px tall on touch (centered on bar)
      const linkDotTop = isTouch ? row.rowTop + (ROW_HEIGHT - 44) / 2 : barTop;
      const linkDotBottom = isTouch ? linkDotTop + 44 : barBottom;

      if (
        canvasX >= linkDotLeft &&
        canvasX <= linkDotRight &&
        canvasY >= linkDotTop &&
        canvasY <= linkDotBottom
      ) {
        return { taskId, rowIndex, barLeft, barRight, barTop, barBottom, type: 'link-dot' };
      }

      // --- Resize handle zone: [barRight - 8, barRight + 4] x bar ---
      // Expand to 20px wide on touch: [barRight - 12, barRight + 8]
      const resizeLeft = isTouch ? barRight - 12 : barRight - RESIZE_HANDLE_WIDTH;
      const resizeRight = isTouch ? barRight + 8 : barRight + RESIZE_RIGHT_OVERHANG;

      if (
        canvasX >= resizeLeft &&
        canvasX <= resizeRight &&
        canvasY >= barTop &&
        canvasY <= barBottom
      ) {
        return { taskId, rowIndex, barLeft, barRight, barTop, barBottom, type: 'resize' };
      }

      // --- Bar body: [barLeft, barRight - 8] x bar ---
      if (
        canvasX >= barLeft &&
        canvasX <= barRight - RESIZE_HANDLE_WIDTH &&
        canvasY >= barTop &&
        canvasY <= barBottom
      ) {
        return { taskId, rowIndex, barLeft, barRight, barTop, barBottom, type: 'bar' };
      }
    }

    return null;
  }
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
    const barRight = dateToLeft(task.finish, scales);
    const barTop = i * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;
    const barBottom = barTop + BAR_HEIGHT;
    const rowTop = i * ROW_HEIGHT + HEADER_HEIGHT;

    rows.push({ taskId: task.id, rowIndex: i, barLeft, barRight, barTop, barBottom, rowTop });
  }

  return new HitIndexImpl(rows);
}
