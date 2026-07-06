/**
 * Pure state machine for the Gantt drag-to-link gesture (#1666).
 *
 * No DOM, no React, no Canvas 2D. Instantiated once in GanttEngineImpl and
 * driven by pointer events from the interaction canvas — a sibling to
 * GanttDragFSM (move/resize) and GanttPanFSM (pan). Kept separate so the
 * bar move/resize logic stays untouched: arming on a `link-dot` hit zone
 * short-circuits the move path before the drag FSM ever sees the pointer.
 *
 * States:
 *   IDLE          — no link gesture in progress
 *   ARMED         — pointer down on a link-dot, waiting for the 4px threshold
 *   DRAGGING      — threshold crossed; the preview line is live and follows
 *                   the pointer. Whether the current pointer position is over a
 *                   valid target is carried in `context.targetId` (set by the
 *                   engine from the hit index each move) — a valid target is any
 *                   bar that is not the source.
 *   DROP          — pointer released; caller decides commit vs. cancel and reset()
 *   CANCELLED     — Escape / pointercancel; caller reset()s silently
 *
 * Commit rule (owned by the caller): emit `create-link` only when the pointer
 * was released while state === DRAGGING AND a valid `targetId` is set. A release
 * in place (still ARMED, threshold never crossed), over empty space, or over the
 * source bar itself is a silent cancel — no event.
 */

export type LinkFSMState = 'IDLE' | 'ARMED' | 'DRAGGING' | 'DROP' | 'CANCELLED';

export interface LinkFSMContext {
  /** Source task the gesture started from (the bar whose link-dot was grabbed). */
  sourceId: string | null;
  /** Canvas-origin x of the source bar's FINISH edge — the preview line origin. */
  sourceBarRight: number;
  /** Canvas-origin y of the source bar's vertical center — the preview line origin. */
  sourceBarCenterY: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  pointerId: number | null;
  /** Current valid hover target (a bar other than the source), else null. */
  targetId: string | null;
  /** Canvas-origin rect of the target bar (snap endpoint + ring), or null. */
  targetBarLeft: number | null;
  targetBarRight: number | null;
  targetBarTop: number | null;
  targetBarBottom: number | null;
}

/** Threshold in logical pixels before an armed link-dot press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

const INITIAL_CONTEXT: LinkFSMContext = {
  sourceId: null,
  sourceBarRight: 0,
  sourceBarCenterY: 0,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
  pointerId: null,
  targetId: null,
  targetBarLeft: null,
  targetBarRight: null,
  targetBarTop: null,
  targetBarBottom: null,
};

export class GanttLinkFSM {
  private _state: LinkFSMState = 'IDLE';
  private _context: LinkFSMContext = { ...INITIAL_CONTEXT };

  get state(): LinkFSMState {
    return this._state;
  }

  get context(): Readonly<LinkFSMContext> {
    return this._context;
  }

  /**
   * Called on pointerdown over a link-dot hit zone.
   *
   * @param sourceId          The task whose link-dot was grabbed
   * @param sourceBarRight     Canvas-origin x of the source bar's finish edge
   * @param sourceBarCenterY   Canvas-origin y of the source bar's center
   * @param x                  Canvas-origin X of the pointer
   * @param y                  Canvas-origin Y of the pointer
   * @param pointerId          From PointerEvent.pointerId
   */
  onPointerDown(
    sourceId: string,
    sourceBarRight: number,
    sourceBarCenterY: number,
    x: number,
    y: number,
    pointerId: number,
  ): void {
    if (this._state !== 'IDLE') return;
    this._context = {
      ...INITIAL_CONTEXT,
      sourceId,
      sourceBarRight,
      sourceBarCenterY,
      startX: x,
      startY: y,
      currentX: x,
      currentY: y,
      pointerId,
    };
    this._state = 'ARMED';
  }

  /**
   * Called on pointermove. Advances ARMED → DRAGGING once the 4px threshold is
   * crossed, and records the pointer position.
   *
   * Returns:
   *   'started' — threshold just crossed this frame (ARMED → DRAGGING)
   *   'moving'  — already DRAGGING
   *   'none'    — not applicable (IDLE / below threshold / dropped / cancelled)
   */
  onPointerMove(x: number, y: number): 'started' | 'moving' | 'none' {
    if (this._state !== 'ARMED' && this._state !== 'DRAGGING') return 'none';
    this._context = { ...this._context, currentX: x, currentY: y };

    if (this._state === 'ARMED') {
      const dist = Math.hypot(x - this._context.startX, y - this._context.startY);
      if (dist > DRAG_THRESHOLD_PX) {
        this._state = 'DRAGGING';
        return 'started';
      }
      return 'none';
    }
    return 'moving';
  }

  /**
   * Set (or clear) the current valid hover target. Called by the engine each
   * move with the target rect computed from the hit index. Pass `null` for the
   * id to clear (pointer over empty space or over the source bar itself).
   */
  setTarget(
    targetId: string | null,
    rect: { left: number; right: number; top: number; bottom: number } | null,
  ): void {
    this._context = {
      ...this._context,
      targetId,
      targetBarLeft: rect?.left ?? null,
      targetBarRight: rect?.right ?? null,
      targetBarTop: rect?.top ?? null,
      targetBarBottom: rect?.bottom ?? null,
    };
  }

  /** Called on pointerup. Transitions to DROP so the caller can decide commit vs. cancel. */
  onPointerUp(): void {
    if (this._state === 'ARMED' || this._state === 'DRAGGING') {
      this._state = 'DROP';
    }
  }

  /** Called on Escape / pointercancel. Transitions to CANCELLED (silent). */
  onCancel(): void {
    if (this._state !== 'IDLE') {
      this._state = 'CANCELLED';
    }
  }

  /** Reset back to IDLE. Call after handling DROP or CANCELLED. */
  reset(): void {
    this._state = 'IDLE';
    this._context = { ...INITIAL_CONTEXT };
  }
}
