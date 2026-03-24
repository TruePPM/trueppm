import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDragCpm } from './useDragCpm';
import { useDragStore } from '@/stores/dragStore';
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

vi.mock('@/features/gantt/buildSubgraph', () => ({
  buildSubgraph: vi.fn(() => ({ tasks: [], edges: [] })),
}));

// ---------------------------------------------------------------------------
// Mock scales — minimal shape that satisfies dateFromCanvasLeft maths
// ---------------------------------------------------------------------------

// Typed as a plain object — GanttScaleData from SVAR has no package-level TS declarations;
// the hook only reads _scales via dateFromCanvasLeft which accepts any object with the right shape.
const MOCK_SCALES = {
  width: 4380,
  start: new Date('2025-01-01T00:00:00Z'),
  end: new Date('2025-12-31T00:00:00Z'),
  diff: (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 86_400_000),
};

// ---------------------------------------------------------------------------
// Mock IApi — stores intercept callbacks so tests can fire events
// ---------------------------------------------------------------------------

type InterceptCb = (ev: Record<string, unknown>) => void;

// Local interface — avoids importing IApi which resolves to `any` in this project's SVAR setup
interface MockGanttApi {
  intercept(event: string, cb: InterceptCb): void;
  getState(): { _scales: typeof MOCK_SCALES };
  exec: ReturnType<typeof vi.fn>;
}

let interceptHandlers: Map<string, InterceptCb>;
let mockApi: MockGanttApi;

function resetApi() {
  interceptHandlers = new Map<string, InterceptCb>();
  mockApi = {
    intercept: vi.fn((event: string, cb: InterceptCb) => {
      interceptHandlers.set(event, cb);
    }),
    getState: vi.fn(() => ({ _scales: MOCK_SCALES })),
    exec: vi.fn(() => Promise.resolve(undefined)),
  };
}

/** Fire a SVAR intercept event by name. */
function fire(event: string, payload: Record<string, unknown>) {
  interceptHandlers.get(event)?.(payload);
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
    isCritical: false,
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

function makeAriaRef(): MutableRefObject<HTMLDivElement | null> {
  const ref = createRef<HTMLDivElement>() as MutableRefObject<HTMLDivElement | null>;
  ref.current = document.createElement('div');
  return ref;
}

function renderCpm(api: MockGanttApi | null = mockApi) {
  const ariaLiveRef = makeAriaRef();
  // IApi resolves to `any` in this project (SVAR has no TS declarations here),
  // so MockGanttApi is assignable without a cast.
  return { ...renderHook(() => useDragCpm({ ganttApi: api, tasks: TASKS, links: LINKS, ariaLiveRef })), ariaLiveRef };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  useDragStore.setState(INITIAL_STORE);
  workerMock.reset();
  resetApi();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDragCpm', () => {
  describe('worker lifecycle', () => {
    it('terminates the worker on unmount', () => {
      const { unmount } = renderCpm();
      unmount();
      expect(workerMock.terminate).toHaveBeenCalledTimes(1);
    });

    it('does not post messages when ganttApi is null', () => {
      renderCpm(null);
      expect(workerMock.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('drag-task event', () => {
    it('transitions the store to dragging with the correct task id', () => {
      renderCpm();
      void act(() => fire('drag-task', { id: 't1' }));
      expect(useDragStore.getState().phase).toBe('dragging');
      expect(useDragStore.getState().draggedTaskId).toBe('t1');
    });
  });

  describe('drag-task-move event', () => {
    it('posts a RECALC message with seq = 1 on the first move', () => {
      renderCpm();
      void act(() => fire('drag-task', { id: 't1' }));
      void act(() => fire('drag-task-move', { id: 't1', left: 0 }));
      expect(workerMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RECALC', draggedTaskId: 't1', seq: 1 }),
      );
    });

    it('increments seq on each move event', () => {
      renderCpm();
      void act(() => fire('drag-task', { id: 't1' }));
      void act(() => fire('drag-task-move', { id: 't1', left: 0 }));
      void act(() => fire('drag-task-move', { id: 't1', left: 100 }));
      expect(workerMock.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ seq: 2 }),
      );
    });
  });

  describe('RESULT message from worker', () => {
    it('updates the store when seq matches the current sequence', () => {
      renderCpm();
      void act(() => fire('drag-task', { id: 't1' }));
      void act(() => fire('drag-task-move', { id: 't1', left: 0 }));
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
      renderCpm();
      void act(() => fire('drag-task', { id: 't1' }));
      // Two moves → seq = 2
      void act(() => fire('drag-task-move', { id: 't1', left: 0 }));
      void act(() => fire('drag-task-move', { id: 't1', left: 50 }));
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
      const { ariaLiveRef } = renderCpm();
      void act(() => fire('drag-task', { id: 't1' }));
      void act(() => fire('drag-task-move', { id: 't1', left: 0 }));
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
      const { ariaLiveRef } = renderCpm();
      void act(() => fire('drag-task', { id: 't1' }));
      void act(() => fire('drag-task-move', { id: 't1', left: 0 }));
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
    it('calls cancelDrag when ev.cancelled is true', () => {
      renderCpm();
      void act(() => fire('drag-task', { id: 't1' }));
      void act(() => fire('drag-task-end', { id: 't1', left: 0, cancelled: true }));
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('calls commitDrag when online and not cancelled', () => {
      renderCpm();
      void act(() => fire('drag-task', { id: 't1' }));
      void act(() => fire('drag-task-end', { id: 't1', left: 0 }));
      expect(useDragStore.getState().phase).toBe('committing');
    });

    it('calls cancelDrag + setError when offline (rule 29)', () => {
      const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      try {
        renderCpm();
        void act(() => fire('drag-task', { id: 't1' }));
        void act(() => fire('drag-task-end', { id: 't1', left: 0 }));
        expect(useDragStore.getState().phase).toBe('error');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('Escape key handler (rule 28)', () => {
    it('cancels an active pointer drag and calls exec drag-task-cancel', () => {
      renderCpm();
      void act(() => fire('drag-task', { id: 't1' }));
      void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(useDragStore.getState().phase).toBe('idle');
      expect(mockApi.exec).toHaveBeenCalledWith('drag-task-cancel', {});
    });

    it('does nothing when phase is already idle', () => {
      renderCpm();
      void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(mockApi.exec).not.toHaveBeenCalledWith('drag-task-cancel', expect.anything());
      expect(useDragStore.getState().phase).toBe('idle');
    });
  });
});
