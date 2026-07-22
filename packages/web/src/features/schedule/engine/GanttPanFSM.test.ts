/**
 * Tests for the drag-to-pan state machine (#491). Pure logic — no DOM, no canvas.
 * The engine owns the scroll math; the FSM only tracks gesture state + last
 * pointer position and reports per-move deltas.
 */
import { describe, it, expect } from 'vitest';
import { GanttPanFSM } from './GanttPanFSM';

describe('GanttPanFSM', () => {
  it('starts IDLE', () => {
    const fsm = new GanttPanFSM();
    expect(fsm.state).toBe('IDLE');
    expect(fsm.isPanning).toBe(false);
    expect(fsm.isArmed).toBe(false);
  });

  it('arms on Space (IDLE → ARMED) and disarms back to IDLE', () => {
    const fsm = new GanttPanFSM();
    fsm.arm();
    expect(fsm.state).toBe('ARMED');
    expect(fsm.isArmed).toBe(true);
    fsm.disarm();
    expect(fsm.state).toBe('IDLE');
  });

  it('does not start a pan from IDLE without Space or middle button', () => {
    const fsm = new GanttPanFSM();
    const claimed = fsm.start(10, 10, 1, /* middle */ false);
    expect(claimed).toBe(false);
    expect(fsm.state).toBe('IDLE');
  });

  it('starts a pan when armed (Space+drag)', () => {
    const fsm = new GanttPanFSM();
    fsm.arm();
    const claimed = fsm.start(10, 10, 1, false);
    expect(claimed).toBe(true);
    expect(fsm.isPanning).toBe(true);
    expect(fsm.pointerId).toBe(1);
  });

  it('starts a pan immediately on the middle button without arming', () => {
    const fsm = new GanttPanFSM();
    const claimed = fsm.start(5, 5, 2, /* middle */ true);
    expect(claimed).toBe(true);
    expect(fsm.isPanning).toBe(true);
  });

  it('reports per-move pixel deltas while panning', () => {
    const fsm = new GanttPanFSM();
    fsm.start(100, 50, 1, true);
    expect(fsm.move(120, 40)).toEqual({ dx: 20, dy: -10 });
    // Deltas are relative to the previous move, not the start.
    expect(fsm.move(115, 45)).toEqual({ dx: -5, dy: 5 });
  });

  it('returns null from move() when not panning', () => {
    const fsm = new GanttPanFSM();
    expect(fsm.move(10, 10)).toBeNull();
    fsm.arm();
    expect(fsm.move(10, 10)).toBeNull(); // ARMED but not yet PANNING
  });

  it('returns to ARMED on end when Space is still held', () => {
    const fsm = new GanttPanFSM();
    fsm.arm();
    fsm.start(0, 0, 1, false);
    fsm.end(/* spaceStillHeld */ true);
    expect(fsm.state).toBe('ARMED');
    expect(fsm.pointerId).toBeNull();
  });

  it('returns to IDLE on end when Space was released', () => {
    const fsm = new GanttPanFSM();
    fsm.start(0, 0, 1, true); // middle-button pan
    fsm.end(/* spaceStillHeld */ false);
    expect(fsm.state).toBe('IDLE');
  });

  it('reset() hard-clears to IDLE from any state (pointercancel)', () => {
    const fsm = new GanttPanFSM();
    fsm.start(0, 0, 3, true);
    fsm.move(50, 50);
    fsm.reset();
    expect(fsm.state).toBe('IDLE');
    expect(fsm.pointerId).toBeNull();
    expect(fsm.move(60, 60)).toBeNull();
  });

  it('disarm() is a no-op mid-pan (release is handled on pointerup)', () => {
    const fsm = new GanttPanFSM();
    fsm.arm();
    fsm.start(0, 0, 1, false);
    fsm.disarm(); // Space released while still dragging
    expect(fsm.isPanning).toBe(true); // unaffected until end()
  });

  it('startTouch() pans immediately from IDLE — no Space-arm, no middle button (#2160)', () => {
    const fsm = new GanttPanFSM();
    const claimed = fsm.startTouch(30, 60, 7);
    expect(claimed).toBe(true);
    expect(fsm.isPanning).toBe(true);
    expect(fsm.pointerId).toBe(7);
    // Deltas flow the same as any other pan.
    expect(fsm.move(10, 40)).toEqual({ dx: -20, dy: -20 });
    // A touch pan ends to IDLE (no Space to remain held).
    fsm.end(/* spaceStillHeld */ false);
    expect(fsm.state).toBe('IDLE');
  });

  it('startTouch() does not restart an in-progress pan', () => {
    const fsm = new GanttPanFSM();
    fsm.startTouch(0, 0, 1);
    fsm.move(10, 10);
    const claimed = fsm.startTouch(100, 100, 2);
    expect(claimed).toBe(false);
    expect(fsm.pointerId).toBe(1); // still the original finger
  });
});
