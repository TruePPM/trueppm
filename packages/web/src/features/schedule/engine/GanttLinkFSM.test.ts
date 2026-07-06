import { describe, it, expect, beforeEach } from 'vitest';
import { GanttLinkFSM } from './GanttLinkFSM';

describe('GanttLinkFSM (drag-to-link, #1666)', () => {
  let fsm: GanttLinkFSM;

  beforeEach(() => {
    fsm = new GanttLinkFSM();
  });

  it('starts in IDLE with an empty context', () => {
    expect(fsm.state).toBe('IDLE');
    expect(fsm.context.sourceId).toBeNull();
    expect(fsm.context.targetId).toBeNull();
  });

  it('arms on pointerdown over a link-dot, recording the source geometry', () => {
    fsm.onPointerDown('a', 200, 14, 205, 14, 1);
    expect(fsm.state).toBe('ARMED');
    expect(fsm.context.sourceId).toBe('a');
    expect(fsm.context.sourceBarRight).toBe(200);
    expect(fsm.context.sourceBarCenterY).toBe(14);
    expect(fsm.context.pointerId).toBe(1);
  });

  it('ignores pointerdown when not IDLE', () => {
    fsm.onPointerDown('a', 200, 14, 205, 14, 1);
    fsm.onPointerDown('b', 300, 42, 305, 42, 2);
    expect(fsm.context.sourceId).toBe('a');
  });

  it('stays ARMED below the 4px threshold, then transitions to DRAGGING once crossed', () => {
    fsm.onPointerDown('a', 200, 14, 205, 14, 1);
    expect(fsm.onPointerMove(206, 15)).toBe('none'); // < 4px
    expect(fsm.state).toBe('ARMED');
    expect(fsm.onPointerMove(215, 14)).toBe('started'); // > 4px
    expect(fsm.state).toBe('DRAGGING');
    expect(fsm.onPointerMove(240, 14)).toBe('moving');
    expect(fsm.context.currentX).toBe(240);
  });

  it('setTarget records a valid target rect and clears it on null', () => {
    fsm.onPointerDown('a', 200, 14, 205, 14, 1);
    fsm.onPointerMove(230, 14);
    fsm.setTarget('b', { left: 300, right: 360, top: 33, bottom: 51 });
    expect(fsm.context.targetId).toBe('b');
    expect(fsm.context.targetBarLeft).toBe(300);
    expect(fsm.context.targetBarBottom).toBe(51);
    fsm.setTarget(null, null);
    expect(fsm.context.targetId).toBeNull();
    expect(fsm.context.targetBarLeft).toBeNull();
  });

  it('drops to DROP on pointerup from DRAGGING (caller decides commit)', () => {
    fsm.onPointerDown('a', 200, 14, 205, 14, 1);
    fsm.onPointerMove(240, 14);
    fsm.setTarget('b', { left: 300, right: 360, top: 33, bottom: 51 });
    fsm.onPointerUp();
    expect(fsm.state).toBe('DROP');
    // The commit decision is the caller's: DROP + a valid targetId.
    expect(fsm.context.sourceId).toBe('a');
    expect(fsm.context.targetId).toBe('b');
  });

  it('drops from ARMED (in-place release, never crossed threshold) — caller cancels silently', () => {
    fsm.onPointerDown('a', 200, 14, 205, 14, 1);
    fsm.onPointerUp();
    // Was never DRAGGING, so the caller must not emit create-link.
    expect(fsm.state).toBe('DROP');
  });

  it('cancels to CANCELLED on onCancel (Escape / pointercancel)', () => {
    fsm.onPointerDown('a', 200, 14, 205, 14, 1);
    fsm.onPointerMove(240, 14);
    fsm.onCancel();
    expect(fsm.state).toBe('CANCELLED');
  });

  it('reset returns to IDLE and clears the context', () => {
    fsm.onPointerDown('a', 200, 14, 205, 14, 1);
    fsm.onPointerMove(240, 14);
    fsm.setTarget('b', { left: 300, right: 360, top: 33, bottom: 51 });
    fsm.reset();
    expect(fsm.state).toBe('IDLE');
    expect(fsm.context.sourceId).toBeNull();
    expect(fsm.context.targetId).toBeNull();
  });

  it('onPointerMove is a no-op after DROP', () => {
    fsm.onPointerDown('a', 200, 14, 205, 14, 1);
    fsm.onPointerMove(240, 14);
    fsm.onPointerUp();
    expect(fsm.onPointerMove(500, 14)).toBe('none');
    expect(fsm.state).toBe('DROP');
  });
});
