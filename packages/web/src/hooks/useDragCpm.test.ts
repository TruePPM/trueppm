import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDragCpm } from './useDragCpm';
import { useDragStore } from '@/stores/dragStore';
import { GanttEngineStub } from '@/features/schedule/engine';
import type { GanttEngineEventMap } from '@/features/schedule/engine';
import type { GanttScaleData } from '@/features/schedule/engine';
import type { ResultMessage } from '@/workers/cpmWorker.types';
import type { Task, TaskLink } from '@/types';
import { createRef, type MutableRefObject } from 'react';

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

vi.mock('@/features/schedule/buildSubgraph', () => ({
  buildSubgraph: vi.fn(() => ({ tasks: [], edges: [] })),
}));

// ---------------------------------------------------------------------------
// Controllable engine — stores event handlers so tests can fire events
// ---------------------------------------------------------------------------

const MOCK_SCALES: GanttScaleData = {
  start: new Date('2025-01-01T00:00:00Z'),
  end: new Date('2025-12-31T00:00:00Z'),
  totalWidth: 364 * 12,
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
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
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

function makeAriaRef(): MutableRefObject<HTMLDivElement | null> {
  const ref = createRef<HTMLDivElement>() as MutableRefObject<HTMLDivElement | null>;
  ref.current = document.createElement('div');
  return ref;
}

function renderCpm(
  engine: ControllableEngine | null,
  keyboardModeRef?: MutableRefObject<boolean>,
) {
  const ariaLiveRef = makeAriaRef();
  return {
    ...renderHook(() =>
      useDragCpm({ engine, tasks: TASKS, links: LINKS, ariaLiveRef, keyboardModeRef }),
    ),
    ariaLiveRef,
  };
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
      void act(() => engine.emit('drag-task', { id: 't1' }));
      expect(useDragStore.getState().phase).toBe('dragging');
      expect(useDragStore.getState().draggedTaskId).toBe('t1');
    });

    it('posts a DRAG_START carrying the subgraph once at drag start (issue 1524)', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      // The subgraph is built and shipped exactly once, on drag start — not per
      // move — so subsequent frames can send only the changed start date.
      expect(workerMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DRAG_START',
          draggedTaskId: 't1',
          subgraph: { tasks: [], edges: [] },
        }),
      );
    });
  });

  describe('drag-task-move event', () => {
    it('posts a DRAG_MOVE with seq = 1 and no subgraph on the first move', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      workerMock.postMessage.mockClear(); // drop the DRAG_START call
      void act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      // Per-frame payload is just {seq, newStartIso} — the worker already holds
      // the resident subgraph, so no subgraph is re-sent (issue 1524).
      const call = workerMock.postMessage.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call).toMatchObject({ type: 'DRAG_MOVE', seq: 1 });
      expect(call).toHaveProperty('newStartIso');
      expect(call).not.toHaveProperty('subgraph');
    });

    it('increments seq on each move event', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      void act(() => engine.emit('drag-task-move', { id: 't1', left: 100 }));
      expect(workerMock.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'DRAG_MOVE', seq: 2 }),
      );
    });
  });

  describe('RESULT message from worker', () => {
    it('updates the store when seq matches the current sequence', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      void act(() => {
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
      void act(() => engine.emit('drag-task', { id: 't1' }));
      // Two moves → seq = 2
      void act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      void act(() => engine.emit('drag-task-move', { id: 't1', left: 50 }));
      // Result for seq = 1 (stale)
      void act(() => {
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
      const engine = new ControllableEngine();
      const { ariaLiveRef } = renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      void act(() => {
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
      const engine = new ControllableEngine();
      const { ariaLiveRef } = renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => engine.emit('drag-task-move', { id: 't1', left: 0 }));
      void act(() => {
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
    it('posts a DRAG_END to release the resident subgraph (issue 1524)', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      workerMock.postMessage.mockClear(); // drop the DRAG_START call
      void act(() => engine.emit('drag-task-end', { id: 't1', left: 0 }));
      expect(workerMock.postMessage).toHaveBeenCalledWith({ type: 'DRAG_END' });
    });

    it('calls cancelDrag when ev.cancelled is true', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => engine.emit('drag-task-end', { id: 't1', left: 0, cancelled: true }));
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('calls commitDrag when online and not cancelled', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => engine.emit('drag-task-end', { id: 't1', left: 0 }));
      expect(useDragStore.getState().phase).toBe('committing');
    });

    it('calls cancelDrag + setError when offline (rule 29)', () => {
      const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      try {
        const engine = new ControllableEngine();
        renderCpm(engine);
        void act(() => engine.emit('drag-task', { id: 't1' }));
        void act(() => engine.emit('drag-task-end', { id: 't1', left: 0 }));
        expect(useDragStore.getState().phase).toBe('error');
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Resize preview (issue #4237) — mirrors the drag-task-* describe blocks
  // above one-for-one, since resize-task-* is the same protocol with a
  // duration override instead of a start override.
  describe('resize-task event', () => {
    it('transitions the store to dragging with the correct task id', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('resize-task', { id: 't1' }));
      expect(useDragStore.getState().phase).toBe('dragging');
      expect(useDragStore.getState().draggedTaskId).toBe('t1');
    });

    it('posts a RESIZE_START carrying the subgraph once at resize start', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('resize-task', { id: 't1' }));
      expect(workerMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'RESIZE_START',
          resizedTaskId: 't1',
          subgraph: { tasks: [], edges: [] },
        }),
      );
    });
  });

  describe('resize-task-move event', () => {
    it('posts a RESIZE_MOVE with seq = 1 and the working-day duration for the dropped edge', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('resize-task', { id: 't1' }));
      workerMock.postMessage.mockClear(); // drop the RESIZE_START call
      // right = 180px → 15 days from the scale origin (12px/day) → the
      // handle is dropped on 2025-01-16 (exclusive edge) → finish 2025-01-15.
      // t1 runs Jan 6 (Mon) .. Jan 15 (Wed) inclusive under the default
      // Mon–Fri mask = 8 working days (vs. its original 5-day duration).
      void act(() => engine.emit('resize-task-move', { id: 't1', right: 180 }));
      expect(workerMock.postMessage).toHaveBeenCalledWith({
        type: 'RESIZE_MOVE',
        seq: 1,
        newDurationDays: 8,
      });
    });

    it('increments seq on each move event', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('resize-task', { id: 't1' }));
      void act(() => engine.emit('resize-task-move', { id: 't1', right: 132 }));
      void act(() => engine.emit('resize-task-move', { id: 't1', right: 180 }));
      expect(workerMock.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'RESIZE_MOVE', seq: 2 }),
      );
    });

    it('does not post a RESIZE_MOVE when the dropped edge resolves before the task start', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('resize-task', { id: 't1' }));
      workerMock.postMessage.mockClear();
      // right = 0 → the scale origin itself (2025-01-01) → exclusive-edge-minus-
      // one-day finish is 2024-12-31, before t1's 2025-01-06 start.
      void act(() => engine.emit('resize-task-move', { id: 't1', right: 0 }));
      expect(workerMock.postMessage).not.toHaveBeenCalled();
    });

    it('uses the project working-days mask passed in, not the Mon–Fri default (#4237)', () => {
      const engine = new ControllableEngine();
      const ariaLiveRef = makeAriaRef();
      // Mon–Sat (63) — one more working day in range than the default Mon–Fri
      // mask, so the two must disagree if the mask is actually threaded through.
      renderHook(() =>
        useDragCpm({
          engine,
          tasks: TASKS,
          links: LINKS,
          ariaLiveRef,
          workingDaysMask: 63,
        }),
      );
      void act(() => engine.emit('resize-task', { id: 't1' }));
      workerMock.postMessage.mockClear();
      void act(() => engine.emit('resize-task-move', { id: 't1', right: 180 }));
      expect(workerMock.postMessage).toHaveBeenCalledWith({
        type: 'RESIZE_MOVE',
        seq: 1,
        newDurationDays: 9,
      });
    });
  });

  describe('resize-task-end event', () => {
    it('posts a RESIZE_END to release the resident subgraph', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('resize-task', { id: 't1' }));
      workerMock.postMessage.mockClear(); // drop the RESIZE_START call
      void act(() => engine.emit('resize-task-end', { id: 't1', right: 0 }));
      expect(workerMock.postMessage).toHaveBeenCalledWith({ type: 'RESIZE_END' });
    });

    it('calls cancelDrag and announces "Resize cancelled" when ev.cancelled is true', () => {
      const engine = new ControllableEngine();
      const { ariaLiveRef } = renderCpm(engine);
      void act(() => engine.emit('resize-task', { id: 't1' }));
      void act(() => engine.emit('resize-task-end', { id: 't1', right: 0, cancelled: true }));
      expect(useDragStore.getState().phase).toBe('idle');
      expect(ariaLiveRef.current?.textContent).toBe('Resize cancelled');
    });

    it('calls commitDrag when online and not cancelled', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('resize-task', { id: 't1' }));
      void act(() => engine.emit('resize-task-end', { id: 't1', right: 0 }));
      expect(useDragStore.getState().phase).toBe('committing');
    });

    it('calls cancelDrag + setError when offline (rule 29)', () => {
      const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      try {
        const engine = new ControllableEngine();
        renderCpm(engine);
        void act(() => engine.emit('resize-task', { id: 't1' }));
        void act(() => engine.emit('resize-task-end', { id: 't1', right: 0 }));
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
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(useDragStore.getState().phase).toBe('idle');
      expect(engine.cancelDragCalled).toBe(true);
    });

    it('does nothing when phase is already idle', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(engine.cancelDragCalled).toBe(false);
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('yields to useKeyboardReschedule when keyboardModeRef is true (issue #34)', () => {
      const engine = new ControllableEngine();
      const keyboardModeRef = { current: true };
      renderCpm(engine, keyboardModeRef);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      // keyboard mode owns Escape — pointer drag must NOT be cancelled
      expect(useDragStore.getState().phase).toBe('dragging');
      expect(engine.cancelDragCalled).toBe(false);
    });

    it('ignores non-Escape keys', () => {
      const engine = new ControllableEngine();
      renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })));
      // Enter must not cancel the drag
      expect(useDragStore.getState().phase).toBe('dragging');
      expect(engine.cancelDragCalled).toBe(false);
    });

    it('works without a keyboardModeRef (optional ref not provided)', () => {
      const engine = new ControllableEngine();
      // renderCpm without a keyboardModeRef — exercises the keyboardModeRef?.current optional chain
      const ariaLiveRef = makeAriaRef();
      renderHook(() =>
        useDragCpm({ engine, tasks: TASKS, links: LINKS, ariaLiveRef }),
      );
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('writes aria-live text on Escape cancel when ariaLiveRef is attached', () => {
      const engine = new ControllableEngine();
      const { ariaLiveRef } = renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(ariaLiveRef.current?.textContent).toBe('Drag cancelled');
    });

    it('writes "Resize cancelled" on Escape cancel of an active resize (#4237)', () => {
      const engine = new ControllableEngine();
      const { ariaLiveRef } = renderCpm(engine);
      void act(() => engine.emit('resize-task', { id: 't1' }));
      void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(useDragStore.getState().phase).toBe('idle');
      expect(engine.cancelDragCalled).toBe(true);
      expect(ariaLiveRef.current?.textContent).toBe('Resize cancelled');
    });
  });

  describe('drag-task-end cancelled branch — aria-live text', () => {
    it('writes "Drag cancelled" to aria-live when drag-task-end is cancelled', () => {
      const engine = new ControllableEngine();
      const { ariaLiveRef } = renderCpm(engine);
      void act(() => engine.emit('drag-task', { id: 't1' }));
      void act(() => engine.emit('drag-task-end', { id: 't1', left: 0, cancelled: true }));
      expect(ariaLiveRef.current?.textContent).toBe('Drag cancelled');
    });

    it('does not throw when ariaLiveRef.current is null on cancelled drag-task-end', () => {
      const engine = new ControllableEngine();
      const ariaLiveRef: MutableRefObject<HTMLDivElement | null> = { current: null };
      renderHook(() =>
        useDragCpm({ engine, tasks: TASKS, links: LINKS, ariaLiveRef }),
      );
      void act(() => engine.emit('drag-task', { id: 't1' }));
      expect(() => {
        act(() => engine.emit('drag-task-end', { id: 't1', left: 0, cancelled: true }));
      }).not.toThrow();
    });

    it('does not throw when ariaLiveRef.current is null on Escape cancel', () => {
      const engine = new ControllableEngine();
      const ariaLiveRef: MutableRefObject<HTMLDivElement | null> = { current: null };
      renderHook(() =>
        useDragCpm({ engine, tasks: TASKS, links: LINKS, ariaLiveRef }),
      );
      void act(() => engine.emit('drag-task', { id: 't1' }));
      expect(() => {
        void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      }).not.toThrow();
    });
  });
});
