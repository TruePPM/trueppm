import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createRef, type MutableRefObject, type RefObject } from 'react';
import { useKeyboardReschedule } from './useKeyboardReschedule';
import { useDragStore } from '@/stores/dragStore';
import { GanttEngineStub } from '@/features/schedule/engine';
import type {
  GanttEngineEventMap,
  GanttScaleData,
} from '@/features/schedule/engine';
import { createCpmWorker } from '@/workers/createCpmWorker';
import type { ResultMessage } from '@/workers/cpmWorker.types';
import type { Task, TaskLink } from '@/types';

// ---------------------------------------------------------------------------
// Hoisted worker mock — the hook sets `worker.onmessage` and calls postMessage
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

const createCpmWorkerMock = vi.mocked(createCpmWorker);

// ---------------------------------------------------------------------------
// Controllable engine — records handlers so tests can fire events
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

  emit<K extends keyof GanttEngineEventMap>(
    event: K,
    payload: GanttEngineEventMap[K],
  ): void {
    this._map.get(event)?.forEach((h) => h(payload));
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Design phase',
    start: '2025-01-06', // Monday
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
    ...overrides,
  };
}

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

interface RenderOpts {
  tasks?: Task[];
  keyboardModeRef?: RefObject<boolean>;
  ariaAssertiveRef?: MutableRefObject<HTMLDivElement | null>;
  ariaLiveRef?: MutableRefObject<HTMLDivElement | null>;
  onOpenDatePopover?: (taskId: string) => void;
}

function renderReschedule(
  engine: ControllableEngine | null,
  opts: RenderOpts = {},
) {
  const ariaLiveRef = opts.ariaLiveRef ?? makeAriaRef();
  const ariaAssertiveRef = opts.ariaAssertiveRef ?? makeAriaRef();
  const keyboardModeRef = opts.keyboardModeRef ?? { current: false };
  const onOpenDatePopover = opts.onOpenDatePopover ?? vi.fn();
  const tasks = opts.tasks ?? [makeTask()];

  const view = renderHook(() =>
    useKeyboardReschedule({
      engine,
      tasks,
      links: LINKS,
      ariaLiveRef,
      ariaAssertiveRef,
      keyboardModeRef,
      onOpenDatePopover,
    }),
  );
  return { ...view, ariaLiveRef, ariaAssertiveRef, keyboardModeRef, onOpenDatePopover };
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  useDragStore.setState(INITIAL_STORE);
  workerMock.reset();
  createCpmWorkerMock.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useKeyboardReschedule', () => {
  describe('worker lifecycle', () => {
    it('does not spawn a worker when engine is null', () => {
      renderReschedule(null);
      expect(createCpmWorkerMock).not.toHaveBeenCalled();
    });

    it('spawns a worker when an engine is provided', () => {
      renderReschedule(new ControllableEngine());
      expect(createCpmWorkerMock).toHaveBeenCalledTimes(1);
    });

    it('terminates the worker on unmount', () => {
      const { unmount } = renderReschedule(new ControllableEngine());
      unmount();
      expect(workerMock.terminate).toHaveBeenCalledTimes(1);
    });
  });

  describe('worker RESULT message → preview + polite aria-live', () => {
    it('applies preview results whose seq is current', () => {
      renderReschedule(new ControllableEngine());
      act(() => {
        workerMock.simulateResult({
          type: 'RESULT',
          seq: 0,
          draggedTaskId: 't1',
          results: [
            {
              taskId: 't1',
              earlyStart: '2025-01-07',
              earlyFinish: '2025-01-11',
              isCritical: false,
              deltaDays: 1,
            },
          ],
          worstMilestone: null,
          overflowCount: 0,
        });
      });
      expect(useDragStore.getState().previewResults).toHaveLength(1);
    });

    it('discards a stale result whose seq is below the current sequence', () => {
      const engine = new ControllableEngine();
      const { keyboardModeRef } = renderReschedule(engine);
      // Enter keyboard mode + two nudges → seqRef advances to 2
      act(() => engine.emit('selection-change', { taskIds: ['t1'] }));
      press('Enter', { shiftKey: true });
      expect(keyboardModeRef.current).toBe(true);
      press('ArrowRight');
      press('ArrowRight');
      useDragStore.setState({ previewResults: [] });
      act(() => {
        workerMock.simulateResult({
          type: 'RESULT',
          seq: 1, // stale — current seq is 2
          draggedTaskId: 't1',
          results: [
            {
              taskId: 't1',
              earlyStart: '2025-01-08',
              earlyFinish: '2025-01-12',
              isCritical: false,
              deltaDays: 2,
            },
          ],
          worstMilestone: null,
          overflowCount: 0,
        });
      });
      expect(useDragStore.getState().previewResults).toHaveLength(0);
    });

    it('ignores a non-RESULT message', () => {
      renderReschedule(new ControllableEngine());
      act(() => {
        // Simulate an unexpected message shape
        workerMock.simulateResult({ type: 'OTHER' } as unknown as ResultMessage);
      });
      expect(useDragStore.getState().previewResults).toHaveLength(0);
    });

    it('announces a milestone slip with plural days', () => {
      const { ariaLiveRef } = renderReschedule(new ControllableEngine());
      act(() => {
        workerMock.simulateResult({
          type: 'RESULT',
          seq: 0,
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

    it('announces a milestone slip with singular day when deltaDays is 1', () => {
      const { ariaLiveRef } = renderReschedule(new ControllableEngine());
      act(() => {
        workerMock.simulateResult({
          type: 'RESULT',
          seq: 0,
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

    it('announces "on schedule" when the milestone does not slip', () => {
      const { ariaLiveRef } = renderReschedule(new ControllableEngine());
      act(() => {
        workerMock.simulateResult({
          type: 'RESULT',
          seq: 0,
          draggedTaskId: 't1',
          results: [],
          worstMilestone: {
            taskId: 'm1',
            name: 'Launch',
            baselineFinish: '2025-03-01',
            newFinish: '2025-03-01',
            deltaDays: 0,
          },
          overflowCount: 0,
        });
      });
      expect(ariaLiveRef.current?.textContent).toBe('Launch on schedule');
    });

    it('leaves aria-live untouched when there is no worst milestone', () => {
      const { ariaLiveRef } = renderReschedule(new ControllableEngine());
      act(() => {
        workerMock.simulateResult({
          type: 'RESULT',
          seq: 0,
          draggedTaskId: 't1',
          results: [],
          worstMilestone: null,
          overflowCount: 0,
        });
      });
      expect(ariaLiveRef.current?.textContent).toBe('');
    });
  });

  describe('entering keyboard mode via Shift+Enter (#2205)', () => {
    it('does nothing when no engine is present', () => {
      renderReschedule(null, { keyboardModeRef: { current: false } });
      press('Enter', { shiftKey: true });
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('plain Enter does NOT start a reschedule (it opens the drawer instead)', () => {
      const engine = new ControllableEngine();
      const { keyboardModeRef } = renderReschedule(engine);
      act(() => engine.emit('selection-change', { taskIds: ['t1'] }));
      press('Enter');
      expect(keyboardModeRef.current).toBe(false);
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('starts a keyboard drag on the selected task via Shift+Enter', () => {
      const engine = new ControllableEngine();
      const { keyboardModeRef, ariaAssertiveRef } = renderReschedule(engine);
      act(() => engine.emit('selection-change', { taskIds: ['t1'] }));
      press('Enter', { shiftKey: true });
      expect(keyboardModeRef.current).toBe(true);
      expect(useDragStore.getState().phase).toBe('dragging');
      expect(useDragStore.getState().draggedTaskId).toBe('t1');
      expect(useDragStore.getState().isKeyboardMode).toBe(true);
      expect(ariaAssertiveRef.current?.textContent).toContain('Keyboard reschedule: Design phase');
    });

    it('ignores non-Enter keys when not in keyboard mode', () => {
      const engine = new ControllableEngine();
      const { keyboardModeRef } = renderReschedule(engine);
      act(() => engine.emit('selection-change', { taskIds: ['t1'] }));
      press('ArrowRight');
      expect(keyboardModeRef.current).toBe(false);
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('does nothing when no task is selected', () => {
      const engine = new ControllableEngine();
      const { keyboardModeRef } = renderReschedule(engine);
      // No selection emitted → selectedTaskIdRef stays null
      press('Enter', { shiftKey: true });
      expect(keyboardModeRef.current).toBe(false);
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('resets the selected task to null when selection is cleared', () => {
      const engine = new ControllableEngine();
      const { keyboardModeRef } = renderReschedule(engine);
      act(() => engine.emit('selection-change', { taskIds: ['t1'] }));
      act(() => engine.emit('selection-change', { taskIds: [] }));
      press('Enter', { shiftKey: true });
      expect(keyboardModeRef.current).toBe(false);
    });

    it('refuses to reschedule a summary task', () => {
      const engine = new ControllableEngine();
      const { keyboardModeRef } = renderReschedule(engine, {
        tasks: [makeTask({ isSummary: true })],
      });
      act(() => engine.emit('selection-change', { taskIds: ['t1'] }));
      press('Enter', { shiftKey: true });
      expect(keyboardModeRef.current).toBe(false);
      expect(useDragStore.getState().phase).toBe('idle');
    });

    it('refuses to reschedule a completed task', () => {
      const engine = new ControllableEngine();
      const { keyboardModeRef } = renderReschedule(engine, {
        tasks: [makeTask({ isComplete: true })],
      });
      act(() => engine.emit('selection-change', { taskIds: ['t1'] }));
      press('Enter', { shiftKey: true });
      expect(keyboardModeRef.current).toBe(false);
    });

    it('refuses when the selected id is not in the task list', () => {
      const engine = new ControllableEngine();
      const { keyboardModeRef } = renderReschedule(engine);
      act(() => engine.emit('selection-change', { taskIds: ['ghost'] }));
      press('Enter', { shiftKey: true });
      expect(keyboardModeRef.current).toBe(false);
    });

    it('suppresses Shift+Enter while the user is typing in an input', () => {
      const engine = new ControllableEngine();
      const { keyboardModeRef } = renderReschedule(engine);
      act(() => engine.emit('selection-change', { taskIds: ['t1'] }));
      const input = document.createElement('input');
      document.body.appendChild(input);
      act(() => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
        );
      });
      expect(keyboardModeRef.current).toBe(false);
      expect(useDragStore.getState().phase).toBe('idle');
      input.remove();
    });
  });

  describe('nudging in keyboard mode', () => {
    function enterMode(engine: ControllableEngine) {
      act(() => engine.emit('selection-change', { taskIds: ['t1'] }));
      press('Enter', { shiftKey: true });
      workerMock.postMessage.mockClear();
    }

    it('posts a RECALC nudged one working day later on ArrowRight', () => {
      const engine = new ControllableEngine();
      const refs = renderReschedule(engine);
      enterMode(engine);
      press('ArrowRight');
      expect(workerMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'RECALC',
          draggedTaskId: 't1',
          newStartIso: '2025-01-07', // Mon → Tue
          subgraph: { tasks: [], edges: [] },
        }),
      );
      expect(useDragStore.getState().keyboardDelta).toBe(1);
      expect(refs.ariaAssertiveRef.current?.textContent).toBe('1 working day later');
    });

    it('nudges five working days with Shift+ArrowRight', () => {
      const engine = new ControllableEngine();
      const refs = renderReschedule(engine);
      enterMode(engine);
      press('ArrowRight', { shiftKey: true });
      expect(workerMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ newStartIso: '2025-01-13' }), // +5 working days
      );
      expect(useDragStore.getState().keyboardDelta).toBe(5);
      expect(refs.ariaAssertiveRef.current?.textContent).toBe('5 working days later');
    });

    it('nudges earlier on ArrowLeft', () => {
      const engine = new ControllableEngine();
      const refs = renderReschedule(engine);
      enterMode(engine);
      press('ArrowLeft');
      expect(useDragStore.getState().keyboardDelta).toBe(-1);
      expect(refs.ariaAssertiveRef.current?.textContent).toBe('1 working day earlier');
    });

    it('announces returning to the original date when the delta cancels out', () => {
      const engine = new ControllableEngine();
      const refs = renderReschedule(engine);
      enterMode(engine);
      press('ArrowRight');
      press('ArrowLeft');
      expect(useDragStore.getState().keyboardDelta).toBe(0);
      expect(refs.ariaAssertiveRef.current?.textContent).toBe('Back to original start date');
    });

    it('opens the date popover on "d"', () => {
      const engine = new ControllableEngine();
      const onOpenDatePopover = vi.fn();
      renderReschedule(engine, { onOpenDatePopover });
      enterMode(engine);
      press('d');
      expect(onOpenDatePopover).toHaveBeenCalledWith('t1');
    });

    it('opens the date popover on capital "D"', () => {
      const engine = new ControllableEngine();
      const onOpenDatePopover = vi.fn();
      renderReschedule(engine, { onOpenDatePopover });
      enterMode(engine);
      press('D');
      expect(onOpenDatePopover).toHaveBeenCalledWith('t1');
    });

    it('does not post a nudge when the drag store has no dragged task', () => {
      // keyboardMode forced true externally, but store has no draggedTaskId
      const engine = new ControllableEngine();
      renderReschedule(engine, { keyboardModeRef: { current: true } });
      press('ArrowRight');
      expect(workerMock.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('confirming and cancelling', () => {
    function enterMode(engine: ControllableEngine) {
      act(() => engine.emit('selection-change', { taskIds: ['t1'] }));
      press('Enter', { shiftKey: true });
    }

    it('commits the reschedule on Enter when online', () => {
      const engine = new ControllableEngine();
      const refs = renderReschedule(engine);
      enterMode(engine);
      press('ArrowRight'); // delta 1 → 2025-01-07
      press('Enter');
      expect(refs.keyboardModeRef.current).toBe(false);
      expect(useDragStore.getState().phase).toBe('committing');
      expect(useDragStore.getState().confirmedStart).toBe('2025-01-07');
      expect(refs.ariaAssertiveRef.current?.textContent).toBe('Reschedule confirmed.');
    });

    it('aborts the commit and warns when offline', () => {
      const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      try {
        const engine = new ControllableEngine();
        const refs = renderReschedule(engine);
        enterMode(engine);
        press('ArrowRight');
        press('Enter');
        expect(refs.keyboardModeRef.current).toBe(false);
        expect(useDragStore.getState().phase).toBe('idle');
        expect(refs.ariaAssertiveRef.current?.textContent).toBe(
          "You're offline — change not saved.",
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('cancels the reschedule on Escape', () => {
      const engine = new ControllableEngine();
      const refs = renderReschedule(engine);
      enterMode(engine);
      press('ArrowRight');
      press('Escape');
      expect(refs.keyboardModeRef.current).toBe(false);
      expect(useDragStore.getState().phase).toBe('idle');
      expect(refs.ariaAssertiveRef.current?.textContent).toBe('Reschedule cancelled.');
    });

    it('still cancels on Escape even when focus is inside an input', () => {
      const engine = new ControllableEngine();
      const refs = renderReschedule(engine);
      enterMode(engine);
      const input = document.createElement('input');
      document.body.appendChild(input);
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(refs.keyboardModeRef.current).toBe(false);
      expect(useDragStore.getState().phase).toBe('idle');
      input.remove();
    });
  });
});
