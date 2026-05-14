import { describe, it, expect, beforeEach } from 'vitest';
import { useDragStore } from './dragStore';
import type { DragPreviewResult, WorstMilestone } from '@/types';

const INITIAL_STATE = {
  phase: 'idle' as const,
  draggedTaskId: null,
  previewResults: [],
  worstMilestone: null,
  overflowCount: 0,
  isKeyboardMode: false,
  keyboardDelta: 0,
  confirmedStart: null,
  buildingTaskId: null,
  buildingStart: null,
  buildingFinish: null,
};

beforeEach(() => {
  useDragStore.setState(INITIAL_STATE);
});

const RESULT: DragPreviewResult = {
  taskId: 't1',
  earlyStart: '2025-01-06',
  earlyFinish: '2025-01-10',
  isCritical: false,
  deltaDays: 2,
};

const MILESTONE: WorstMilestone = {
  taskId: 'm1',
  name: 'Launch',
  baselineFinish: '2025-03-01',
  newFinish: '2025-03-04',
  deltaDays: 3,
};

describe('dragStore', () => {
  it('starts in idle state with empty collections', () => {
    const s = useDragStore.getState();
    expect(s.phase).toBe('idle');
    expect(s.draggedTaskId).toBeNull();
    expect(s.previewResults).toHaveLength(0);
    expect(s.worstMilestone).toBeNull();
    expect(s.overflowCount).toBe(0);
    expect(s.isKeyboardMode).toBe(false);
    expect(s.keyboardDelta).toBe(0);
    expect(s.confirmedStart).toBeNull();
  });

  describe('startDrag', () => {
    it('transitions to dragging and records the task id', () => {
      useDragStore.getState().startDrag('task-abc');
      const s = useDragStore.getState();
      expect(s.phase).toBe('dragging');
      expect(s.draggedTaskId).toBe('task-abc');
    });

    it('defaults isKeyboardMode to false', () => {
      useDragStore.getState().startDrag('t1');
      expect(useDragStore.getState().isKeyboardMode).toBe(false);
    });

    it('sets isKeyboardMode when the flag is true', () => {
      useDragStore.getState().startDrag('t1', true);
      expect(useDragStore.getState().isKeyboardMode).toBe(true);
    });

    it('clears prior preview results on a new drag', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([RESULT], MILESTONE, 2);
      useDragStore.getState().startDrag('t2');
      const s = useDragStore.getState();
      expect(s.previewResults).toHaveLength(0);
      expect(s.worstMilestone).toBeNull();
      expect(s.overflowCount).toBe(0);
      expect(s.keyboardDelta).toBe(0);
    });
  });

  describe('updatePreview', () => {
    it('stores results, worstMilestone, and overflowCount', () => {
      useDragStore.getState().updatePreview([RESULT], MILESTONE, 5);
      const s = useDragStore.getState();
      expect(s.previewResults).toEqual([RESULT]);
      expect(s.worstMilestone).toEqual(MILESTONE);
      expect(s.overflowCount).toBe(5);
    });

    it('accepts a null worstMilestone and zero overflow', () => {
      useDragStore.getState().updatePreview([RESULT], null, 0);
      expect(useDragStore.getState().worstMilestone).toBeNull();
      expect(useDragStore.getState().overflowCount).toBe(0);
    });
  });

  describe('commitDrag', () => {
    it('transitions to committing and clears preview results', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([RESULT], MILESTONE, 1);
      useDragStore.getState().commitDrag();
      const s = useDragStore.getState();
      expect(s.phase).toBe('committing');
      expect(s.previewResults).toHaveLength(0);
      expect(s.worstMilestone).toBeNull();
    });

    it('sets confirmedStart when provided', () => {
      useDragStore.getState().commitDrag('2025-06-01');
      expect(useDragStore.getState().confirmedStart).toBe('2025-06-01');
    });

    it('leaves confirmedStart null when not provided', () => {
      useDragStore.getState().commitDrag();
      expect(useDragStore.getState().confirmedStart).toBeNull();
    });
  });

  describe('cancelDrag', () => {
    it('resets all fields back to idle defaults', () => {
      useDragStore.getState().startDrag('t1', true);
      useDragStore.getState().updatePreview([RESULT], MILESTONE, 3);
      useDragStore.getState().setKeyboardDelta(4);
      useDragStore.getState().cancelDrag();
      const s = useDragStore.getState();
      expect(s).toMatchObject(INITIAL_STATE);
    });
  });

  describe('setError', () => {
    it('sets phase to error', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().setError();
      expect(useDragStore.getState().phase).toBe('error');
    });

    it('preserves draggedTaskId when entering error', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().setError();
      expect(useDragStore.getState().draggedTaskId).toBe('t1');
    });
  });

  describe('setKeyboardDelta', () => {
    it('stores a positive delta', () => {
      useDragStore.getState().setKeyboardDelta(3);
      expect(useDragStore.getState().keyboardDelta).toBe(3);
    });

    it('stores a negative delta', () => {
      useDragStore.getState().setKeyboardDelta(-2);
      expect(useDragStore.getState().keyboardDelta).toBe(-2);
    });

    it('stores zero', () => {
      useDragStore.getState().setKeyboardDelta(5);
      useDragStore.getState().setKeyboardDelta(0);
      expect(useDragStore.getState().keyboardDelta).toBe(0);
    });
  });

  describe('startBuilding / stopBuilding', () => {
    it('startBuilding transitions to building phase with ghost bar dates', () => {
      useDragStore.getState().startBuilding('t-new', '2026-05-14', '2026-05-19');
      const s = useDragStore.getState();
      expect(s.phase).toBe('building');
      expect(s.buildingTaskId).toBe('t-new');
      expect(s.buildingStart).toBe('2026-05-14');
      expect(s.buildingFinish).toBe('2026-05-19');
    });

    it('stopBuilding resets phase to idle and clears building fields', () => {
      useDragStore.getState().startBuilding('t-new', '2026-05-14', '2026-05-19');
      useDragStore.getState().stopBuilding();
      const s = useDragStore.getState();
      expect(s.phase).toBe('idle');
      expect(s.buildingTaskId).toBeNull();
      expect(s.buildingStart).toBeNull();
      expect(s.buildingFinish).toBeNull();
    });

    it('cancelDrag also resets building fields', () => {
      useDragStore.getState().startBuilding('t-new', '2026-05-14', '2026-05-19');
      useDragStore.getState().cancelDrag();
      expect(useDragStore.getState()).toMatchObject(INITIAL_STATE);
    });
  });
});
