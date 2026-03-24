import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDragCpm } from './useDragCpm';
import { useDragStore } from '@/stores/dragStore';
import { GanttEngineStub } from '@/features/gantt/engine/GanttEngineStub';
import type { GanttEngineEventMap } from '@/features/gantt/engine/GanttEngine';
import type { GanttScaleData } from '@/features/gantt/engine/GanttScaleData';
import type { ResultMessage } from '@/workers/cpmWorker.types';
import type { Task, TaskLink } from '@/types';
import { createRef } from 'react';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be created before vi.mock() calls (which are hoisted)
// ---------------------------------------------------------------------------

const workerMock = vi.hoisted(() => {
  let _handler: ((e: MessageEvent) => void) | null = null;
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    get onmessage() {
      return _handler;
    },
    set onmessage(h: ((e: MessageEvent) => void) | null) {
      _handler = h;
    },
    /** Fire a ResultMessage as if coming from the worker. */
    simulateResult(data: ResultMessage) {
      _handler?.(new MessageEvent('message', { data }));
    },
    reset() {
      _handler = null;
      this.postMessage.mockClear();
      this.terminate.mockClear();
    },
  };
});

vi.mock('@/workers/createCpmWorker', () => ({
  createCpmWorker: vi.fn(() => workerMock),
}));

vi.mock('@/features/gantt/buildSubgraph', () => ({
  buildSubgraph: vi.fn(() => ({ tasks: [], edges: [] })),
}));

// ---------------------------------------------------------------------------
// Controllable engine — stores event handlers so tests can fire events
// ---------------------------------------------------------------------------

const MOCK_SCALES: GanttScaleData = {
  start: new Date('2025-01-01T00:00:00Z'),
  end: new Date('2025-12-31T00:00:00Z'),
  totalWidth: 4380,
  zoomLevel: 'week',
  pxPerMs: 12 / 86_400_000,
};

class ControllableEngine extends GanttEngineStub {
  private _map = new Map<string, Set<(p: unknown) => void>>();
  cancelDragCalled = false;

  override readonly scales: GanttScaleData = MOCK_SCALES;

  override on<K extends keyof GanttEngineEventMap>(
    event: K,
    handler: (p: GanttEngineEventMap[K]) => void,
  ): () => void {
    if (!this._map.has(event)) this._map.set(event, new Set());
    const h = handler as (p: unknown) => void;
    this._map.get(event)!.add(h);
    return () => this._map.get(event)?.delete(h);
  }

  emit<K extends keyof GanttEngineEventMap>(event: K, payload: GanttEngineEventMap[K]): void {
    this._map.get(event)?.forEach((h) => h(payload));
  }

  override cancelDrag(): void {
    this.cancelDragCalled = true;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASKS: Task[] = [
  {
    id: 't1',
    wbs: '1',
    name: 'Task 1',
    start: '2025-01-06',
    finish: '2025-01-10',
    duration: 5,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
  },
];
const LINKS: TaskLink[] = [];

const INITIAL_STORE = {
  phase: 'idle' as const,
  draggedTaskId: null,
  previewResults: [],
  worstMilestone: null,
  overflowCount: 0,
  isKeyboardMode: false,
  keyboardDelta: 0,
  confirmedStart: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAriaRef() {
  const ref = createRef<HTMLDivElement | null>() as React.MutableRefObject<HTMLDivElement | null>;
  ref.current = document.createElement('div');
  return ref;
}

function renderCpm(
  engine: ControllableEngine | null,
  keyboardModeRef?: React.MutableRefObject<boolean>,
) {
  const ariaLiveRef = makeAriaRef();
  return renderHook(() =>
    useDragCpm({ engine, tasks: TASKS, links: LINKS, ariaLiveRef, keyboardModeRef }),
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  useDragStore.setState(INITIAL_STORE);
  workerMock.reset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDragCpm', () => {
  describe('worker lifecycle', () => {
    it('terminates the worker on unmount', () => {
      const engine = new ControllableEngine();
      const { unmount } = renderCpm(engine);
      unmount();
      expect(workerMock.terminate).toHaveBeenCalledTimes(1);
    });

    it('does not post messages when engine is null', () => {
      renderCpm(null);
      expect(workerMock.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('drag-task event', () => {
    it('transitions the store to dragging with the correct task id', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      act(() => engine.emit('drag-task', { id: 't1' }));
      expect(useDragStore.getState().phase).toBe('dragging');
      expect(useDragStore.getState().draggedTaskId).toBe('t1');
    });
  });

  describe('drag-task-move event', () => {
    it('posts a RECALC message with seq = 1 on the first move', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      act(() => engine.emit('drag-task', { id: 't1' }));
      act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      expect(workerMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RECALC', draggedTaskId: 't1', seq: 1 }),
      );
    });

    it('increments seq on each move event', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      act(() => engine.emit('drag-task', { id: 't1' }));
      act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      act(() => engine.emit('drag-task-move', { id: 't1', left: 100 }));
      expect(workerMock.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ seq: 2 }),
      );
    });
  });

  describe('RESULT message from worker', () => {
    it('updates the store when seq matches the current sequence', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      act(() => engine.emit('drag-task', { id: 't1' }));
      act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      act(() => {
        workerMock.simulateResult({
          type: 'RESULT',
          seq: 1,
          draggedTaskId: 't1',
          results: [
            { taskId: 't1', earlyStart: '2025-01-07', earlyFinish: '2025-01-11', isCritical: false, deltaDays: 1 },
          ],
          worstMilestone: null,
          overflowCount: 0,
        });
      });
      expect(useDragStore.getState().previewResults).toHaveLength(1);
    });

    it('discards a stale result whose seq is less than the current seq', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      act(() => engine.emit('drag-task', { id: 't1' }));
      // Two moves → seq = 2
      act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      act(() => engine.emit('drag-task-move', { id: 't1', left: 50 }));
      // Result for seq = 1 (stale)
      act(() => {
        workerMock.simulateResult({
          type: 'RESULT',
          seq: 1,
          draggedTaskId: 't1',
          results: [
            { taskId: 't1', earlyStart: '2025-01-07', earlyFinish: '2025-01-11', isCritical: false, deltaDays: 1 },
          ],
          worstMilestone: null,
          overflowCount: 0,
        });
      });
      // Store must remain empty — stale result rejected
      expect(useDragStore.getState().previewResults).toHaveLength(0);
    });

    it('updates the aria-live ref with the worst milestone slip message', () => {
      const ariaLiveRef = makeAriaRef();
      const engine = new ControllableEngine();
      renderHook(() =>
        useDragCpm({ engine, tasks: TASKS, links: LINKS, ariaLiveRef }),
      );
      act(() => engine.emit('drag-task', { id: 't1' }));
      act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      act(() => {
        workerMock.simulateResult({
          type: 'RESULT',
          seq: 1,
          draggedTaskId: 't1',
          results: [],
          worstMilestone: {
            taskId: 'm1',
            name: 'Launch',
            baselineFinish: '2025-03-01',
            newFinish: '2025-03-04',
            deltaDays: 3,
          },
          overflowCount: 0,
        });
      });
      expect(ariaLiveRef.current?.textContent).toBe('Launch slips 3 days');
    });

    it('uses singular "day" when deltaDays = 1', () => {
      const ariaLiveRef = makeAriaRef();
      const engine = new ControllableEngine();
      renderHook(() =>
        useDragCpm({ engine, tasks: TASKS, links: LINKS, ariaLiveRef }),
      );
      act(() => engine.emit('drag-task', { id: 't1' }));
      act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      act(() => {
        workerMock.simulateResult({
          type: 'RESULT',
          seq: 1,
          draggedTaskId: 't1',
          results: [],
          worstMilestone: {
            taskId: 'm1',
            name: 'Ship',
            baselineFinish: '2025-03-01',
            newFinish: '2025-03-02',
            deltaDays: 1,
          },
          overflowCount: 0,
        });
      });
      expect(ariaLiveRef.current?.textContent).toBe('Ship slips 1 day');
    });
  });

  describe('drag-task-end event', () => {
    it('calls cancelDrag when ev.cancelled is true', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      act(() => engine.emit('drag-task', { id: 't1' }));
      act(() => engine.emit('drag-task-end', { id: 't1', left: 0, cancelled: true }));
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('calls commitDrag when online and not cancelled', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      act(() => engine.emit('drag-task', { id: 't1' }));
      act(() => engine.emit('drag-task-end', { id: 't1', left: 0 }));
      expect(useDragStore.getState().phase).toBe('committing');
    });

    it('calls cancelDrag + setError when offline (rule 29)', () => {
      const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      try {
        const engine = new ControllableEngine();
        renderCpm(engine);
        act(() => engine.emit('drag-task', { id: 't1' }));
        act(() => engine.emit('drag-task-end', { id: 't1', left: 0 }));
        expect(useDragStore.getState().phase).toBe('error');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('Escape key handler (rule 28)', () => {
    it('cancels an active pointer drag and calls engine.cancelDrag', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      act(() => engine.emit('drag-task', { id: 't1' }));
      act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(useDragStore.getState().phase).toBe('idle');
      expect(engine.cancelDragCalled).toBe(true);
    });

    it('does nothing when phase is already idle', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(engine.cancelDragCalled).toBe(false);
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('yields to useKeyboardReschedule when keyboardModeRef is true (issue #34)', () => {
      const engine = new ControllableEngine();
      const keyboardModeRef = { current: true };
      renderCpm(engine, keyboardModeRef);
      act(() => engine.emit('drag-task', { id: 't1' }));
      act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      // keyboard mode owns Escape — pointer drag must NOT be cancelled
      expect(useDragStore.getState().phase).toBe('dragging');
      expect(engine.cancelDragCalled).toBe(false);
    });
  });
});
