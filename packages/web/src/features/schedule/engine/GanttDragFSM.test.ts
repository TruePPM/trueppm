import { describe, it, expect, beforeEach } from 'vitest';
import { GanttDragFSM } from './GanttDragFSM';

describe('GanttDragFSM', () => {
  let fsm: GanttDragFSM;

  beforeEach(() => {
    fsm = new GanttDragFSM();
  });

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  it('starts in IDLE', () => {
    expect(fsm.state).toBe('IDLE');
    expect(fsm.context.taskId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // pointerdown
  // ---------------------------------------------------------------------------

  it('transitions to HOVER_WAIT on pointerdown', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    expect(fsm.state).toBe('HOVER_WAIT');
    expect(fsm.context.taskId).toBe('task-1');
    expect(fsm.context.startX).toBe(100);
    expect(fsm.context.startY).toBe(50);
    expect(fsm.context.pointerId).toBe(1);
    expect(fsm.context.isDragType).toBe('move');
  });

  it('ignores pointerdown when not IDLE', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onPointerDown('task-2', 200, 80, 2, 'resize'); // second down — ignored
    expect(fsm.context.taskId).toBe('task-1');
    expect(fsm.context.pointerId).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // pointermove — below threshold
  // ---------------------------------------------------------------------------

  it('returns none and stays in HOVER_WAIT when movement < 4px', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    const result = fsm.onPointerMove(103, 50); // 3px — below 4px threshold
    expect(result).toBe('none');
    expect(fsm.state).toBe('HOVER_WAIT');
  });

  it('returns none when idle (no pointer down)', () => {
    const result = fsm.onPointerMove(100, 50);
    expect(result).toBe('none');
    expect(fsm.state).toBe('IDLE');
  });

  // ---------------------------------------------------------------------------
  // pointermove — crossing threshold (move)
  // ---------------------------------------------------------------------------

  it('transitions to DRAG_STARTED when movement > 4px on move gesture', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    const result = fsm.onPointerMove(105, 50); // 5px — crosses threshold
    expect(result).toBe('started');
    expect(fsm.state).toBe('DRAG_STARTED');
  });

  it('transitions to DRAGGING on the next move after DRAG_STARTED', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onPointerMove(105, 50); // → DRAG_STARTED
    const result = fsm.onPointerMove(110, 50); // → DRAGGING
    expect(result).toBe('moved');
    expect(fsm.state).toBe('DRAGGING');
  });

  it('continues returning moved while DRAGGING', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onPointerMove(105, 50); // → DRAG_STARTED
    fsm.onPointerMove(110, 50); // → DRAGGING
    const result = fsm.onPointerMove(120, 50);
    expect(result).toBe('moved');
    expect(fsm.state).toBe('DRAGGING');
  });

  it('updates currentX/Y on every move', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onPointerMove(105, 55);
    expect(fsm.context.currentX).toBe(105);
    expect(fsm.context.currentY).toBe(55);
  });

  // ---------------------------------------------------------------------------
  // pointermove — threshold with diagonal movement
  // ---------------------------------------------------------------------------

  it('crosses threshold via diagonal movement (hypot)', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    // 3px horizontal + 3px vertical = 4.24px > 4px threshold
    const result = fsm.onPointerMove(103, 53);
    expect(result).toBe('started');
  });

  // ---------------------------------------------------------------------------
  // pointermove — resize gesture
  // ---------------------------------------------------------------------------

  it('transitions to RESIZING (not DRAG_STARTED) for resize gesture', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'resize');
    const result = fsm.onPointerMove(105, 50);
    expect(result).toBe('started');
    expect(fsm.state).toBe('RESIZING');
  });

  it('returns moved when RESIZING', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'resize');
    fsm.onPointerMove(105, 50); // → RESIZING
    const result = fsm.onPointerMove(115, 50);
    expect(result).toBe('moved');
    expect(fsm.state).toBe('RESIZING');
  });

  // ---------------------------------------------------------------------------
  // pointerup
  // ---------------------------------------------------------------------------

  it('transitions to DROP on pointerup from HOVER_WAIT', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onPointerUp();
    expect(fsm.state).toBe('DROP');
  });

  it('transitions to DROP on pointerup from DRAGGING', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onPointerMove(105, 50); // → DRAG_STARTED
    fsm.onPointerMove(110, 50); // → DRAGGING
    fsm.onPointerUp();
    expect(fsm.state).toBe('DROP');
  });

  it('transitions to DROP on pointerup from RESIZING', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'resize');
    fsm.onPointerMove(105, 50); // → RESIZING
    fsm.onPointerUp();
    expect(fsm.state).toBe('DROP');
  });

  it('ignores pointerup when IDLE', () => {
    fsm.onPointerUp();
    expect(fsm.state).toBe('IDLE'); // no transition
  });

  // ---------------------------------------------------------------------------
  // cancel
  // ---------------------------------------------------------------------------

  it('transitions to CANCELLED on cancel from HOVER_WAIT', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onCancel();
    expect(fsm.state).toBe('CANCELLED');
  });

  it('transitions to CANCELLED on cancel from DRAGGING', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onPointerMove(105, 50);
    fsm.onPointerMove(110, 50);
    fsm.onCancel();
    expect(fsm.state).toBe('CANCELLED');
  });

  it('ignores cancel when IDLE', () => {
    fsm.onCancel();
    expect(fsm.state).toBe('IDLE'); // no transition
  });

  // ---------------------------------------------------------------------------
  // reset
  // ---------------------------------------------------------------------------

  it('resets to IDLE and clears context', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onPointerMove(105, 50);
    fsm.onPointerUp();
    fsm.reset();
    expect(fsm.state).toBe('IDLE');
    expect(fsm.context.taskId).toBeNull();
    expect(fsm.context.pointerId).toBeNull();
    expect(fsm.context.isDragType).toBeNull();
    expect(fsm.context.startX).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // pointermove no-ops in terminal states
  // ---------------------------------------------------------------------------

  it('returns none on pointermove after DROP', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onPointerUp(); // → DROP
    expect(fsm.onPointerMove(200, 200)).toBe('none');
  });

  it('returns none on pointermove after CANCELLED', () => {
    fsm.onPointerDown('task-1', 100, 50, 1, 'move');
    fsm.onCancel(); // → CANCELLED
    expect(fsm.onPointerMove(200, 200)).toBe('none');
  });
});
