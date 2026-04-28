/**
 * Pure state machine for Gantt bar drag interactions.
 *
 * No DOM, no React, no Canvas 2D. Instantiated once in GanttEngineImpl and
 * driven by pointer events from the interaction canvas.
 *
 * States:
 *   IDLE         — no pointer activity
 *   HOVER_WAIT   — pointer down, no movement yet (waiting for 4px threshold)
 *   DRAG_STARTED — threshold crossed, drag committed (setPointerCapture called)
 *   DRAGGING     — move gesture active
 *   RESIZING     — resize gesture active
 *   DROP         — pointer released; caller should emit drag-end and reset
 *   CANCELLED    — drag cancelled (Escape / pointercancel)
 *
 * Design rules enforced:
 * - Rule 64: 4px threshold IDLE → DRAG_STARTED
 * - Rule 66: pointer capture managed by caller on DRAG_STARTED
 */

export type DragFSMState =
  | 'IDLE'
  | 'HOVER_WAIT'
  | 'DRAG_STARTED'
  | 'DRAGGING'
  | 'RESIZING'
  | 'DROP'
  | 'CANCELLED';

export interface DragFSMContext {
  taskId: string | null;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  pointerId: number | null;
  isDragType: 'move' | 'resize' | null;
}

/** Threshold in logical pixels before a click becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

const INITIAL_CONTEXT: DragFSMContext = {
  taskId: null,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
  pointerId: null,
  isDragType: null,
};

export class GanttDragFSM {
  private _state: DragFSMState = 'IDLE';
  private _context: DragFSMContext = { ...INITIAL_CONTEXT };

  get state(): DragFSMState {
    return this._state;
  }

  get context(): Readonly<DragFSMContext> {
    return this._context;
  }

  /**
   * Called on pointerdown over a task bar hit zone.
   *
   * @param taskId     The task that was hit
   * @param x          Canvas-origin X in logical px
   * @param y          Canvas-origin Y in logical px
   * @param pointerId  From PointerEvent.pointerId
   * @param isDragType Whether the pointer is over a move zone or resize handle
   */
  onPointerDown(
    taskId: string,
    x: number,
    y: number,
    pointerId: number,
    isDragType: 'move' | 'resize',
  ): void {
    if (this._state !== 'IDLE') return;

    this._context = {
      taskId,
      startX: x,
      startY: y,
      currentX: x,
      currentY: y,
      pointerId,
      isDragType,
    };
    this._state = 'HOVER_WAIT';
  }

  /**
   * Called on pointermove.
   *
   * Returns:
   *   'started' — when the 4px threshold is just crossed this frame
   *   'moved'   — when already dragging/resizing
   *   'none'    — when idle or in HOVER_WAIT below threshold
   */
  onPointerMove(x: number, y: number): 'moved' | 'started' | 'none' {
    if (this._state === 'IDLE' || this._state === 'DROP' || this._state === 'CANCELLED') {
      return 'none';
    }

    this._context = { ...this._context, currentX: x, currentY: y };

    if (this._state === 'HOVER_WAIT') {
      const dist = Math.hypot(x - this._context.startX, y - this._context.startY);
      if (dist > DRAG_THRESHOLD_PX) {
        this._state =
          this._context.isDragType === 'resize' ? 'RESIZING' : 'DRAG_STARTED';
        return 'started';
      }
      return 'none';
    }

    if (this._state === 'DRAG_STARTED') {
      // Immediately transition to DRAGGING on first move after threshold
      this._state = 'DRAGGING';
      return 'moved';
    }

    // DRAGGING or RESIZING
    return 'moved';
  }

  /**
   * Called on pointerup. Transitions to DROP so the caller can emit the
   * appropriate event, then call reset().
   */
  onPointerUp(): void {
    if (
      this._state === 'HOVER_WAIT' ||
      this._state === 'DRAG_STARTED' ||
      this._state === 'DRAGGING' ||
      this._state === 'RESIZING'
    ) {
      this._state = 'DROP';
    }
  }

  /**
   * Called on pointercancel or programmatic Escape cancellation.
   * Transitions to CANCELLED so the caller can emit with { cancelled: true }.
   */
  onCancel(): void {
    if (this._state !== 'IDLE') {
      this._state = 'CANCELLED';
    }
  }

  /**
   * Reset back to IDLE. Call after handling DROP or CANCELLED.
   */
  reset(): void {
    this._state = 'IDLE';
    this._context = { ...INITIAL_CONTEXT };
  }
}
