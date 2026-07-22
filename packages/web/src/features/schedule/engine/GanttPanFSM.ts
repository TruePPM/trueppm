/**
 * Pure state machine for drag-to-pan the Gantt timeline (#491).
 *
 * No DOM, no React, no Canvas 2D. Instantiated once in GanttEngineImpl and
 * driven by pointer events from the interaction canvas. It coexists with the
 * task-bar drag FSM (GanttDragFSM) and is arbitrated on pointerdown: when the
 * user holds Space or presses the middle button, the pan FSM claims the gesture
 * and the drag FSM is bypassed entirely (rule 129).
 *
 * Pan is DIRECT 1:1 manipulation — there is intentionally NO momentum / inertia.
 * That keeps it exempt from prefers-reduced-motion (rule 70 / rule 130): there
 * is no animation to suppress. Do not add inertia without gating it on
 * reduced-motion.
 *
 * States:
 *   IDLE     — no pan gesture
 *   ARMED    — Space held with the canvas hovered/focused; cursor = grab.
 *              Not yet panning — waiting for a pointerdown.
 *   PANNING  — actively dragging the viewport (Space+drag or middle-drag);
 *              cursor = grabbing.
 *
 * The FSM only tracks gesture state and the last pointer position; the engine
 * owns the scroll math (it knows scrollLeft/scrollTop and their clamps).
 */

export type PanFSMState = 'IDLE' | 'ARMED' | 'PANNING';

export interface PanDelta {
  /** Pixels the pointer moved since the previous move (to subtract from scroll). */
  dx: number;
  dy: number;
}

export class GanttPanFSM {
  private _state: PanFSMState = 'IDLE';
  private _lastX = 0;
  private _lastY = 0;
  private _pointerId: number | null = null;

  get state(): PanFSMState {
    return this._state;
  }

  get isPanning(): boolean {
    return this._state === 'PANNING';
  }

  get isArmed(): boolean {
    return this._state === 'ARMED';
  }

  get pointerId(): number | null {
    return this._pointerId;
  }

  /** Space pressed while the canvas is hovered/focused — arm the pan. */
  arm(): void {
    if (this._state === 'IDLE') {
      this._state = 'ARMED';
    }
  }

  /** Space released — disarm (no effect mid-pan; release is handled on pointerup). */
  disarm(): void {
    if (this._state === 'ARMED') {
      this._state = 'IDLE';
    }
  }

  /**
   * Begin a pan gesture on pointerdown.
   *
   * @param x         Viewport-relative pointer x (clientX is fine; only deltas matter)
   * @param y         Viewport-relative pointer y
   * @param pointerId From PointerEvent.pointerId
   * @param middle    True when the middle mouse button initiated the gesture —
   *                  pans immediately without the Space-arm step.
   * @returns true if the pan claimed the gesture (caller bypasses the drag FSM)
   */
  start(x: number, y: number, pointerId: number, middle: boolean): boolean {
    if (this._state === 'PANNING') return true;
    if (this._state !== 'ARMED' && !middle) return false;
    this._state = 'PANNING';
    this._lastX = x;
    this._lastY = y;
    this._pointerId = pointerId;
    return true;
  }

  /**
   * Begin a pan gesture from a single-finger touch on empty canvas (#2160).
   *
   * Touch has no Space-arm step and no middle button, so an empty-canvas touch
   * drag pans directly. Bar/resize/link hits are arbitrated by the engine before
   * this is called, so reaching here means the finger landed on empty canvas.
   *
   * @returns true if the pan claimed the gesture (always, unless already panning).
   */
  startTouch(x: number, y: number, pointerId: number): boolean {
    if (this._state === 'PANNING') return false;
    this._state = 'PANNING';
    this._lastX = x;
    this._lastY = y;
    this._pointerId = pointerId;
    return true;
  }

  /**
   * Continue a pan on pointermove. Returns the pixel delta since the last move,
   * or null when not panning. The engine subtracts the delta from its scroll
   * offsets (drag content right → scroll left decreases).
   */
  move(x: number, y: number): PanDelta | null {
    if (this._state !== 'PANNING') return null;
    const dx = x - this._lastX;
    const dy = y - this._lastY;
    this._lastX = x;
    this._lastY = y;
    return { dx, dy };
  }

  /**
   * End the active pan on pointerup. Returns to ARMED when Space is still held
   * (so the next drag pans again without re-pressing Space), else IDLE.
   *
   * @param spaceStillHeld Whether Space remains down at release time.
   */
  end(spaceStillHeld: boolean): void {
    if (this._state === 'PANNING') {
      this._state = spaceStillHeld ? 'ARMED' : 'IDLE';
      this._pointerId = null;
    }
  }

  /** Hard reset to IDLE (pointercancel, destroy). */
  reset(): void {
    this._state = 'IDLE';
    this._pointerId = null;
  }
}
