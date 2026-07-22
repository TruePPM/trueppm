/**
 * Integration coverage for the ARIA grid overlay's keyboard contract (#1776).
 *
 * Mounts ScheduleAriaOverlay together with useKeyboardReschedule — exactly as
 * ScheduleView does — so the tests exercise the real interplay: the overlay's
 * React handler selects a task, the engine emits `selection-change`
 * synchronously, and the document-level reschedule listener (which fires after
 * React's root-container handler in bubble order) sees the selection on the
 * same keydown. The announced "Press Enter to reschedule" capability must be
 * real (WCAG 4.1.3), not a code-reading assumption.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useRef } from 'react';
import type { GanttEngine, GanttEngineEventMap } from './engine';
import { ScheduleAriaOverlay } from './ScheduleAriaOverlay';
import { useKeyboardReschedule } from '@/hooks/useKeyboardReschedule';
import { useDragStore } from '@/stores/dragStore';
import type { Task, TaskLink } from '@/types';

// jsdom has no ResizeObserver; the overlay only uses it to track viewport size.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

vi.mock('@/workers/createCpmWorker', () => ({
  createCpmWorker: () => ({
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
  }),
}));

/** Minimal engine fake: synchronous emitter + real selection, like the canvas impl. */
function makeEngine() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const selected = new Set<string>();
  const fake = {
    scales: null,
    scrollLeft: 0,
    selectedTaskIds: selected,
    scrollToDate: vi.fn(),
    selectTask(taskId: string | null) {
      selected.clear();
      if (taskId) selected.add(taskId);
      const set = listeners.get('selection-change');
      // Synchronous emit — mirrors GanttEngineImpl._applySelection.
      set?.forEach((h) => h({ taskIds: Array.from(selected) }));
    },
    openTask(taskId: string) {
      // Mirrors GanttEngineImpl.openTask — emits 'task-open' for the drawer.
      const set = listeners.get('task-open');
      set?.forEach((h) => h({ id: taskId }));
    },
    on<K extends keyof GanttEngineEventMap>(
      event: K,
      handler: (payload: GanttEngineEventMap[K]) => void,
    ) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const h = handler as (payload: unknown) => void;
      set.add(h);
      return () => set.delete(h);
    },
  };
  return fake as unknown as GanttEngine;
}

function makeTask(id: string, name: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name,
    start: '2026-04-06',
    finish: '2026-04-10',
    duration: 5,
    isSummary: false,
    isComplete: false,
    isCritical: false,
    isMilestone: false,
    parentId: null,
    wbs: '1',
    ...overrides,
  } as unknown as Task;
}

const TASKS: Task[] = [
  makeTask('t1', 'Design'),
  makeTask('t2', 'Build'),
  makeTask('t3', 'Test'),
];
const LINKS: TaskLink[] = [];

function Harness({ engine, tasks }: { engine: GanttEngine; tasks: Task[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ariaLiveRef = useRef<HTMLDivElement>(null);
  const ariaAssertiveRef = useRef<HTMLDivElement>(null);
  const keyboardModeRef = useRef(false);
  useKeyboardReschedule({
    engine,
    tasks,
    links: LINKS,
    ariaLiveRef,
    ariaAssertiveRef,
    keyboardModeRef,
    onOpenDatePopover: () => {},
  });
  return (
    <div ref={containerRef}>
      <div ref={ariaLiveRef} data-testid="live" />
      <div ref={ariaAssertiveRef} data-testid="assertive" />
      <ScheduleAriaOverlay engine={engine} tasks={tasks} links={LINKS} containerRef={containerRef} />
    </div>
  );
}

function cellFor(name: string): HTMLElement {
  return screen.getByRole('gridcell', { name: new RegExp(name) });
}

beforeEach(() => {
  useDragStore.setState({
    phase: 'idle',
    draggedTaskId: null,
    isKeyboardMode: false,
    keyboardDelta: 0,
  });
});

afterEach(cleanup);

describe('ScheduleAriaOverlay keyboard contract (#1776)', () => {
  it('Enter opens the task detail drawer (task-open) and does NOT start a reschedule (#2205)', () => {
    const engine = makeEngine();
    const onOpen = vi.fn();
    engine.on('task-open', onOpen);
    render(<Harness engine={engine} tasks={TASKS} />);
    fireEvent.keyDown(cellFor('Design'), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith({ id: 't1' });
    // Enter no longer enters keyboard-reschedule mode.
    expect(useDragStore.getState().isKeyboardMode).toBe(false);
  });

  it('Shift+Enter on a reschedulable row starts a keyboard reschedule on the same press (#2205)', () => {
    const engine = makeEngine();
    render(<Harness engine={engine} tasks={TASKS} />);
    fireEvent.keyDown(cellFor('Design'), { key: 'Enter', shiftKey: true });
    expect(engine.selectedTaskIds.has('t1')).toBe(true);
    expect(useDragStore.getState().isKeyboardMode).toBe(true);
    expect(useDragStore.getState().draggedTaskId).toBe('t1');
  });

  it("'r' is the single-key alias to start a keyboard reschedule (#2205)", () => {
    const engine = makeEngine();
    render(<Harness engine={engine} tasks={TASKS} />);
    fireEvent.keyDown(cellFor('Design'), { key: 'r' });
    expect(engine.selectedTaskIds.has('t1')).toBe(true);
    expect(useDragStore.getState().isKeyboardMode).toBe(true);
    expect(useDragStore.getState().draggedTaskId).toBe('t1');
  });

  it('Space selects without starting a reschedule', () => {
    const engine = makeEngine();
    render(<Harness engine={engine} tasks={TASKS} />);
    fireEvent.keyDown(cellFor('Design'), { key: ' ' });
    expect(engine.selectedTaskIds.has('t1')).toBe(true);
    expect(useDragStore.getState().isKeyboardMode).toBe(false);
  });

  it('ArrowDown moves DOM focus row by row — navigation does not stall on the first cell', () => {
    const engine = makeEngine();
    render(<Harness engine={engine} tasks={TASKS} />);
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowDown' });
    expect(cellFor('Build')).toHaveFocus();
    // The second press must fire on the NEW cell — this stalled before #1776,
    // when the roving tabindex moved but DOM focus stayed on the old cell.
    fireEvent.keyDown(cellFor('Build'), { key: 'ArrowDown' });
    expect(cellFor('Test')).toHaveFocus();
    fireEvent.keyDown(cellFor('Test'), { key: 'ArrowUp' });
    expect(cellFor('Build')).toHaveFocus();
  });

  it('Home and End jump to the first and last row (role="grid" contract)', () => {
    const engine = makeEngine();
    render(<Harness engine={engine} tasks={TASKS} />);
    fireEvent.keyDown(cellFor('Design'), { key: 'End' });
    expect(cellFor('Test')).toHaveFocus();
    expect(cellFor('Test')).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(cellFor('Test'), { key: 'Home' });
    expect(cellFor('Design')).toHaveFocus();
  });

  it('yields all grid navigation while a keyboard reschedule is active', () => {
    const engine = makeEngine();
    render(<Harness engine={engine} tasks={TASKS} />);
    fireEvent.keyDown(cellFor('Design'), { key: 'Enter', shiftKey: true });
    expect(useDragStore.getState().isKeyboardMode).toBe(true);
    // Mid-reschedule, Up/Down must not move the roving focus out from under
    // the nudge — the document-level hook owns the keyboard until confirm.
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowDown' });
    expect(cellFor('Design')).toHaveAttribute('tabindex', '0');
    expect(cellFor('Build')).toHaveAttribute('tabindex', '-1');
  });

  // #2185: aria-selected must track engine selection changes. It previously read
  // engine.selectedTaskIds (a mutable Set) at render but only re-rendered on
  // scroll/resize, so canvas-click or keyboard selection left it stale (WCAG 4.1.2).
  it('reflects a canvas-side selection change in aria-selected without a re-render trigger', () => {
    const engine = makeEngine();
    render(<Harness engine={engine} tasks={TASKS} />);
    expect(cellFor('Build')).toHaveAttribute('aria-selected', 'false');
    // Simulate a canvas click that selects t2 outside the overlay's own handler.
    act(() => engine.selectTask('t2'));
    expect(cellFor('Build')).toHaveAttribute('aria-selected', 'true');
    expect(cellFor('Design')).toHaveAttribute('aria-selected', 'false');
    // Selecting another task clears the first.
    act(() => engine.selectTask('t3'));
    expect(cellFor('Build')).toHaveAttribute('aria-selected', 'false');
    expect(cellFor('Test')).toHaveAttribute('aria-selected', 'true');
  });

  it('sets aria-selected on the cell selected via Space', () => {
    const engine = makeEngine();
    render(<Harness engine={engine} tasks={TASKS} />);
    fireEvent.keyDown(cellFor('Design'), { key: ' ' });
    expect(cellFor('Design')).toHaveAttribute('aria-selected', 'true');
  });

  it('announces the real key map in the static grid help (#1776)', () => {
    const engine = makeEngine();
    render(<Harness engine={engine} tasks={TASKS} />);
    const help = document.getElementById('schedule-grid-help');
    expect(help?.textContent).toMatch(/Home and End/);
    expect(help?.textContent).toMatch(/Enter to open the focused task's details/i);
    expect(help?.textContent).toMatch(/Shift\+Enter or R to reschedule/i);
    expect(help?.textContent).toMatch(/left and right arrow keys nudge/i);
    expect(help?.textContent).toMatch(/Escape cancels/);
  });
});
