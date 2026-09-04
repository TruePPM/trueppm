/**
 * Branch coverage for the ARIA grid overlay's rendering contract.
 *
 * Complements the three sibling specs:
 *  - ScheduleAriaOverlay.keyboard.test.tsx  — the Enter / Shift+Enter / r / Space
 *    interplay with useKeyboardReschedule
 *  - ScheduleAriaOverlay.depDescription.test.ts / .rescheduleHint.test.ts — the
 *    two other exported pure helpers
 *
 * What is exercised here: `buildTaskAriaLabel` (rule 69), the virtualized row
 * window, focus-ring geometry against a real GanttScaleData, the engine-less
 * fallbacks, scroll-into-view on far jumps, and the live-region announcement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ROW_HEIGHT_FINE, ROW_HEIGHT_COARSE } from './scheduleConstants';
import { stubCoarsePointer, restoreCoarsePointer } from '@/test/coarsePointer';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { RefObject } from 'react';
import type { GanttEngine, GanttEngineEventMap, GanttScaleData } from './engine';
import { buildScaleData, dateToLeft } from './engine';
import {
  ScheduleAriaOverlay,
  buildTaskAriaLabel,
  emptySprintCadenceSentence,
} from './ScheduleAriaOverlay';
import type { SprintBand } from './sprintBands';
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The fine-pointer height, named as such (#2997): the row model is a runtime
// value now, and jsdom's missing `matchMedia` is what resolves it to 28 here.
const ROW_HEIGHT = ROW_HEIGHT_FINE;
const HEADER_HEIGHT = 28;

function makeTask(id: string, name: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name,
    start: '2026-04-06',
    finish: '2026-04-10',
    duration: 5,
    progress: 0,
    isSummary: false,
    isComplete: false,
    isCritical: false,
    isMilestone: false,
    parentId: null,
    wbs: '1',
    status: 'not_started',
    ...overrides,
  } as unknown as Task;
}

function makeLink(sourceId: string, targetId: string): TaskLink {
  return {
    id: `${sourceId}-${targetId}`,
    sourceId,
    targetId,
    type: 'FS',
    lag: 0,
    isCritical: false,
  } as unknown as TaskLink;
}

interface EngineOptions {
  scales?: GanttScaleData | null;
  scrollLeft?: number;
  preselected?: string[];
}

interface EngineFake {
  engine: GanttEngine;
  emitScroll: (scrollLeft: number) => void;
  scrollToDate: ReturnType<typeof vi.fn>;
  selectTask: ReturnType<typeof vi.fn>;
  openTask: ReturnType<typeof vi.fn>;
}

/** Minimal engine fake: synchronous emitter + real selection, like the canvas impl. */
function makeEngine({ scales = null, scrollLeft = 0, preselected = [] }: EngineOptions = {}): EngineFake {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const selected = new Set<string>(preselected);
  const scrollToDate = vi.fn<(iso: string) => void>();
  const selectTask = vi.fn<(taskId: string | null) => void>((taskId) => {
    selected.clear();
    if (taskId) selected.add(taskId);
    listeners.get('selection-change')?.forEach((h) => h({ taskIds: Array.from(selected) }));
  });
  const openTask = vi.fn<(taskId: string) => void>();

  const fake = {
    scales,
    scrollLeft,
    selectedTaskIds: selected,
    scrollToDate,
    selectTask,
    openTask,
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

  return {
    engine: fake as unknown as GanttEngine,
    emitScroll: (sl: number) => {
      listeners.get('scroll')?.forEach((h) => h({ scrollLeft: sl }));
    },
    scrollToDate,
    selectTask,
    openTask,
  };
}

/**
 * The overlay reads `scrollTop` / `clientHeight` off the scroll container and
 * writes `scrollTop` back when a far jump needs the row brought into the window.
 * jsdom has no layout, so both are defined explicitly.
 */
function makeScrollHost(clientHeight: number): HTMLDivElement {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true });
  document.body.appendChild(host);
  return host;
}

interface MountOptions {
  tasks?: Task[];
  links?: TaskLink[];
  engine?: GanttEngine | null;
  clientHeight?: number;
  container?: HTMLDivElement;
}

function mount({
  tasks = TASKS,
  links = [],
  engine = null,
  clientHeight = 300,
  container,
}: MountOptions = {}) {
  const host = container ?? makeScrollHost(clientHeight);
  const containerRef: RefObject<HTMLDivElement | null> = { current: host };
  render(
    <ScheduleAriaOverlay engine={engine} tasks={tasks} links={links} containerRef={containerRef} />,
  );
  return { host };
}

const TASKS: Task[] = [
  makeTask('t1', 'Design'),
  makeTask('t2', 'Build'),
  makeTask('t3', 'Test'),
];

function cellFor(name: string): HTMLElement {
  return screen.getByRole('option', { name: new RegExp(name) });
}

beforeEach(() => {
  useDragStore.setState({
    phase: 'idle',
    draggedTaskId: null,
    isKeyboardMode: false,
    keyboardDelta: 0,
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// buildTaskAriaLabel (rule 69)
// ---------------------------------------------------------------------------

describe('buildTaskAriaLabel (rule 69 canonical format)', () => {
  it('names the task, its duration, and its UTC start/finish dates', () => {
    expect(buildTaskAriaLabel(makeTask('t1', 'Design'))).toBe(
      'Design, 5 days, starts Apr 6, finishes Apr 10',
    );
  });

  it('appends the critical-path suffix only for critical tasks', () => {
    expect(buildTaskAriaLabel(makeTask('t1', 'Design', { isCritical: true }))).toBe(
      'Design, 5 days, starts Apr 6, finishes Apr 10, on the critical path',
    );
  });

  it('reports "unscheduled" when the start date is missing', () => {
    expect(buildTaskAriaLabel(makeTask('t1', 'Design', { start: '' }))).toBe(
      'Design, 5 days, unscheduled',
    );
  });

  it('reports "unscheduled" when the finish date is missing', () => {
    expect(buildTaskAriaLabel(makeTask('t1', 'Design', { finish: '' }))).toBe(
      'Design, 5 days, unscheduled',
    );
  });

  it('formats dates in UTC regardless of the local timezone offset', () => {
    // Jan 1 would read as Dec 31 if the label leaked into a negative-offset
    // local zone — the format pins timeZone: 'UTC'.
    const label = buildTaskAriaLabel(
      makeTask('t1', 'Kickoff', { start: '2026-01-01', finish: '2026-01-01', duration: 1 }),
    );
    expect(label).toBe('Kickoff, 1 days, starts Jan 1, finishes Jan 1');
  });

  // #2727: delivery mode is announced since the visual encoding (gutter/chip/
  // texture, #2727 pt.7) is sighted-only.
  it('appends the delivery-mode suffix when the task carries one', () => {
    expect(
      buildTaskAriaLabel(makeTask('t1', 'Design', { deliveryMode: 'scrum' })),
    ).toBe('Design, 5 days, starts Apr 6, finishes Apr 10, Scrum delivery');
  });

  it('appends the delivery-mode suffix to an unscheduled task too', () => {
    expect(
      buildTaskAriaLabel(makeTask('t1', 'Design', { start: '', deliveryMode: 'kanban' })),
    ).toBe('Design, 5 days, unscheduled, Kanban delivery');
  });

  // #3040: the canvas is aria-hidden, so this label is the ONLY channel by which
  // a bar's mode reaches a screen reader. Before this the label was built from
  // the row's OWN stored field while the outline chip two feet away was built
  // from the rolled-up subtree, so a MIXED phase announced a single mode and the
  // mixed state was carried by a color band and a texture alone (WCAG 1.4.1).
  it('announces the ROLLED-UP mode over the row’s own field, and names the constituents', () => {
    const phase = makeTask('p1', 'Phase 4', { deliveryMode: 'scrum' });
    expect(buildTaskAriaLabel(phase, undefined, { kind: 'mixed', parts: ['waterfall', 'scrum'] })).toBe(
      'Phase 4, 5 days, starts Apr 6, finishes Apr 10, Mixed delivery — this branch contains waterfall and scrum work',
    );
  });

  it('drops the suffix for a baseline row, matching the chip that draws nothing', () => {
    const t = makeTask('t1', 'Design', { deliveryMode: 'waterfall' });
    expect(buildTaskAriaLabel(t, undefined, { kind: 'waterfall', parts: ['waterfall'] })).toBe(
      'Design, 5 days, starts Apr 6, finishes Apr 10',
    );
  });

  it('keeps the row’s own field when no rollup is passed (the program schedule)', () => {
    const phase = makeTask('p1', 'Phase 4', { deliveryMode: 'scrum' });
    expect(buildTaskAriaLabel(phase)).toBe(
      'Phase 4, 5 days, starts Apr 6, finishes Apr 10, Scrum delivery',
    );
  });

  // #2738: the sprint-window band is paint on an aria-hidden canvas, so without
  // this suffix a screen-reader user cannot learn a bar sits inside a sprint.
  const BAND: SprintBand = {
    sprintId: 'sp1',
    name: 'Sprint 4',
    startDate: '2026-04-06',
    finishDate: '2026-04-17',
    firstRow: 0,
    lastRow: 0,
  };

  it('names the sprint window AND its dates, not just membership', () => {
    // Membership alone is not the read: what a sighted user takes from the band
    // is where the bar sits relative to the window's edges.
    expect(buildTaskAriaLabel(makeTask('t1', 'Design'), BAND)).toBe(
      'Design, 5 days, starts Apr 6, finishes Apr 10, in Sprint 4 (Apr 6 – Apr 17)',
    );
  });

  it('calls out a bar that finishes past the window — the reason to look', () => {
    expect(
      buildTaskAriaLabel(makeTask('t1', 'Design', { finish: '2026-04-24' }), BAND),
    ).toBe(
      'Design, 5 days, starts Apr 6, finishes Apr 24, in Sprint 4 (Apr 6 – Apr 17), finishes after the sprint window',
    );
  });

  it('stays silent about sprints for a row no band covers', () => {
    expect(buildTaskAriaLabel(makeTask('t1', 'Design'), undefined)).toBe(
      'Design, 5 days, starts Apr 6, finishes Apr 10',
    );
  });

  it('carries the sprint suffix after the delivery mode, and on unscheduled rows', () => {
    expect(
      buildTaskAriaLabel(makeTask('t1', 'Design', { deliveryMode: 'scrum' }), BAND),
    ).toBe(
      'Design, 5 days, starts Apr 6, finishes Apr 10, Scrum delivery, in Sprint 4 (Apr 6 – Apr 17)',
    );
    expect(buildTaskAriaLabel(makeTask('t1', 'Design', { start: '' }), BAND)).toBe(
      'Design, 5 days, unscheduled, in Sprint 4 (Apr 6 – Apr 17)',
    );
  });

  it('omits the delivery-mode suffix when the task carries none', () => {
    expect(buildTaskAriaLabel(makeTask('t1', 'Design'))).not.toMatch(/delivery/);
  });

  it('combines the critical-path and delivery-mode suffixes in order', () => {
    expect(
      buildTaskAriaLabel(
        makeTask('t1', 'Design', { isCritical: true, deliveryMode: 'waterfall' }),
      ),
    ).toBe('Design, 5 days, starts Apr 6, finishes Apr 10, on the critical path, Waterfall delivery');
  });
});

// ---------------------------------------------------------------------------
// Grid structure
// ---------------------------------------------------------------------------

describe('ScheduleAriaOverlay listbox structure (#2727 — role="listbox"/"option", not role="grid")', () => {
  it('exposes one option per task with the canonical label and set position', () => {
    mount();
    const list = screen.getByRole('listbox', { name: 'Schedule chart' });
    expect(list).not.toHaveAttribute('aria-rowcount');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(cellFor('Build')).toHaveAttribute(
      'aria-label',
      'Build, 5 days, starts Apr 6, finishes Apr 10',
    );
    expect(cellFor('Build')).toHaveAttribute('aria-setsize', '3');
    expect(cellFor('Test')).toHaveAttribute('aria-posinset', '3');
  });

  it('renders an empty list — and no roving tab stop — when there are no tasks', () => {
    mount({ tasks: [] });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('makes the first row the tab stop until the user focuses another one (#779)', () => {
    mount();
    expect(cellFor('Design')).toHaveAttribute('tabindex', '0');
    expect(cellFor('Build')).toHaveAttribute('tabindex', '-1');

    fireEvent.focus(cellFor('Build'));
    expect(cellFor('Build')).toHaveAttribute('tabindex', '0');
    expect(cellFor('Design')).toHaveAttribute('tabindex', '-1');
  });

  it('describes a task with links and omits aria-describedby for a task without any (#1371)', () => {
    mount({ links: [makeLink('t1', 't2')] });
    const design = cellFor('Design');
    const describedBy = design.getAttribute('aria-describedby');
    expect(describedBy).toBe('schedule-deps-t1');
    expect(document.getElementById(describedBy ?? '')).toHaveTextContent('Leads to: Build (FS).');
    // t3 has no edges at all, so it gets no description node.
    expect(cellFor('Test')).not.toHaveAttribute('aria-describedby');
  });

  it('omits every dep description when there are no links', () => {
    mount();
    expect(cellFor('Design')).not.toHaveAttribute('aria-describedby');
    expect(document.querySelectorAll('[id^="schedule-deps-"]')).toHaveLength(0);
  });

  it('seeds aria-selected from the engine selection that exists at mount', () => {
    const { engine } = makeEngine({ preselected: ['t2'] });
    mount({ engine });
    expect(cellFor('Build')).toHaveAttribute('aria-selected', 'true');
    expect(cellFor('Design')).toHaveAttribute('aria-selected', 'false');
  });

  it('falls back to an empty selection when there is no engine', () => {
    mount({ engine: null });
    expect(cellFor('Design')).toHaveAttribute('aria-selected', 'false');
  });
});

// ---------------------------------------------------------------------------
// Focus-ring geometry
// ---------------------------------------------------------------------------

describe('ScheduleAriaOverlay focus-ring geometry', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-04-30');

  it('collapses the ring to zero width when the engine has no scale yet', () => {
    mount({ engine: makeEngine({ scales: null }).engine });
    expect(cellFor('Design').style.width).toBe('0px');
    expect(cellFor('Design').style.left).toBe('0px');
  });

  it('frames a bar across its INCLUSIVE finish date (#950)', () => {
    mount({ engine: makeEngine({ scales }).engine });
    // Apr 6 → Apr 10 inclusive = 5 days at the week tier's 12 px/day.
    expect(cellFor('Design').style.width).toBe('60px');
    expect(Number.parseFloat(cellFor('Design').style.left)).toBe(dateToLeft('2026-04-06', scales));
  });

  it('keeps a milestone diamond ring narrow rather than extending it a full day', () => {
    const milestone = makeTask('m1', 'Go live', {
      start: '2026-04-06',
      finish: '2026-04-06',
      isMilestone: true,
      duration: 0,
    });
    const bar = makeTask('b1', 'Same-day task', {
      start: '2026-04-06',
      finish: '2026-04-06',
      duration: 1,
    });
    mount({ tasks: [milestone, bar], engine: makeEngine({ scales }).engine });
    // Milestone: right edge == left edge, clamped to the 2px minimum.
    expect(cellFor('Go live').style.width).toBe('2px');
    // Non-milestone same-day bar: one full day wide.
    expect(cellFor('Same-day task').style.width).toBe('12px');
  });

  it('shifts the ring left by the engine horizontal scroll offset', () => {
    mount({ engine: makeEngine({ scales, scrollLeft: 0 }).engine });
    const atOrigin = Number.parseFloat(cellFor('Design').style.left);
    cleanup();

    mount({ engine: makeEngine({ scales, scrollLeft: 30 }).engine });
    const scrolled = Number.parseFloat(cellFor('Design').style.left);
    expect(atOrigin - scrolled).toBe(30);
    // Horizontal scroll must not change the bar's width.
    expect(cellFor('Design').style.width).toBe('60px');
  });
});

// ---------------------------------------------------------------------------
// Virtualization
// ---------------------------------------------------------------------------

describe('ScheduleAriaOverlay row virtualization', () => {
  const MANY = Array.from({ length: 40 }, (_, i) => makeTask(`t${i}`, `Task ${i}`));

  it('renders only the visible window plus overscan, clamped to the first row', () => {
    mount({ tasks: MANY, clientHeight: 300 });
    // scrollTop 0 → firstRow clamps to 0; maxY = 300 - 28 header + 140 overscan.
    const cells = screen.getAllByRole('option');
    expect(cells).toHaveLength(16);
    expect(screen.getByRole('option', { name: /Task 0,/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Task 20,/ })).not.toBeInTheDocument();
  });

  it('drops rows above the window and clamps the last row to the task count on scroll', () => {
    const { host } = mount({ tasks: MANY, clientHeight: 300 });
    host.scrollTop = 1000;
    fireEvent.scroll(host);

    expect(screen.queryByRole('option', { name: /Task 0,/ })).not.toBeInTheDocument();
    // Last row is clamped to tasks.length - 1 even though maxY runs past it.
    const last = screen.getByRole('option', { name: /Task 39,/ });
    expect(last).toBeInTheDocument();
    expect(last).toHaveAttribute('aria-posinset', '40');
  });

  it('tracks scrollTop from the engine scroll event', () => {
    const host = makeScrollHost(300);
    const containerRef: RefObject<HTMLDivElement | null> = { current: host };
    const { engine, emitScroll } = makeEngine();
    render(
      <ScheduleAriaOverlay engine={engine} tasks={MANY} links={[]} containerRef={containerRef} />,
    );
    host.scrollTop = 1000;
    act(() => emitScroll(0));
    expect(screen.queryByRole('option', { name: /Task 0,/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Task 39,/ })).toBeInTheDocument();
  });

  it('survives a null scroll container — engine scroll events are ignored', () => {
    const containerRef: RefObject<HTMLDivElement | null> = { current: null };
    const { engine, emitScroll } = makeEngine();
    render(
      <ScheduleAriaOverlay engine={engine} tasks={TASKS} links={[]} containerRef={containerRef} />,
    );
    act(() => emitScroll(120));
    // viewportHeight stays 0, so only the overscan window renders — and nothing throws.
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation edges
// ---------------------------------------------------------------------------

describe('ScheduleAriaOverlay keyboard edges', () => {
  it('announces the reschedule convention for the newly focused row', () => {
    mount();
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowDown' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Build. Press Enter to open details, Shift+Enter to reschedule via keyboard.',
    );
  });

  it('stays silent when moving onto a summary or pinned row (#1031, #2827)', () => {
    const tasks = [
      makeTask('t1', 'Design'),
      makeTask('t2', 'Phase rollup', { isSummary: true }),
      // Pinned means complete AND carrying an actual (#2827) — completion alone
      // leaves the task network-scheduled and therefore reschedulable.
      makeTask('t3', 'Shipped', { isComplete: true, actualFinish: '2026-04-20' }),
    ];
    mount({ tasks });
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowDown' });
    expect(screen.getByRole('status')).toHaveTextContent('');
    fireEvent.keyDown(cellFor('Phase rollup'), { key: 'ArrowDown' });
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('announces a complete row that carries no actuals (#2827)', () => {
    // It is still scheduled through the network and the keyboard can move it,
    // so withholding the hint would hide a shortcut that works.
    const tasks = [makeTask('t1', 'Design'), makeTask('t2', 'Site survey', { isComplete: true })];
    mount({ tasks });
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowDown' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Site survey. Press Enter to open details, Shift+Enter to reschedule via keyboard.',
    );
  });

  it('does nothing at the top and bottom edges of the grid', () => {
    const { scrollToDate, engine } = makeEngine();
    mount({ engine });
    // ArrowUp from the first row has no previous task.
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowUp' });
    expect(scrollToDate).not.toHaveBeenCalled();
    expect(cellFor('Design')).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(cellFor('Design'), { key: 'End' });
    expect(cellFor('Test')).toHaveAttribute('tabindex', '0');
    scrollToDate.mockClear();
    // ArrowDown from the last row has no next task.
    fireEvent.keyDown(cellFor('Test'), { key: 'ArrowDown' });
    expect(scrollToDate).not.toHaveBeenCalled();
    expect(cellFor('Test')).toHaveAttribute('tabindex', '0');
  });

  it('scrolls the bar into horizontal view via the engine on every move', () => {
    const { scrollToDate, engine } = makeEngine();
    mount({ engine, tasks: [makeTask('t1', 'Design'), makeTask('t2', 'Build', { start: '2026-05-04' })] });
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowDown' });
    expect(scrollToDate).toHaveBeenCalledWith('2026-05-04');
  });

  it('ignores keys the grid does not own (Left/Right belong to the nudge)', () => {
    const { engine, selectTask, openTask, scrollToDate } = makeEngine();
    mount({ engine });
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowRight' });
    fireEvent.keyDown(cellFor('Design'), { key: 'Tab' });
    expect(selectTask).not.toHaveBeenCalled();
    expect(openTask).not.toHaveBeenCalled();
    expect(scrollToDate).not.toHaveBeenCalled();
  });

  it("accepts uppercase 'R' as the reschedule alias", () => {
    const { engine, selectTask } = makeEngine();
    mount({ engine });
    fireEvent.keyDown(cellFor('Design'), { key: 'R' });
    expect(selectTask).toHaveBeenCalledWith('t1');
  });

  it('is inert on Enter / r / Space while the engine is still null', () => {
    mount({ engine: null });
    fireEvent.keyDown(cellFor('Design'), { key: 'Enter' });
    fireEvent.keyDown(cellFor('Design'), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(cellFor('Design'), { key: 'r' });
    fireEvent.keyDown(cellFor('Design'), { key: ' ' });
    // No engine to select or open against — the grid must not crash, and no row
    // ever reports itself as selected.
    expect(cellFor('Design')).toHaveAttribute('aria-selected', 'false');
  });

  it('still roves the tab stop with no engine attached', () => {
    mount({ engine: null });
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowDown' });
    expect(cellFor('Build')).toHaveAttribute('tabindex', '0');
  });

  it('still roves when there is no scroll container to bring the row into view', () => {
    const containerRef: RefObject<HTMLDivElement | null> = { current: null };
    const { engine, scrollToDate } = makeEngine();
    render(
      <ScheduleAriaOverlay engine={engine} tasks={TASKS} links={[]} containerRef={containerRef} />,
    );
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowDown' });
    expect(cellFor('Build')).toHaveAttribute('tabindex', '0');
    // The horizontal scroll still happens — only the vertical scroll-into-view
    // depends on the container.
    expect(scrollToDate).toHaveBeenCalledWith('2026-04-06');
  });

  it('does not move the roving focus while a keyboard reschedule owns the keys', () => {
    useDragStore.setState({ isKeyboardMode: true });
    const { engine, selectTask } = makeEngine();
    mount({ engine });
    fireEvent.keyDown(cellFor('Design'), { key: 'ArrowDown' });
    fireEvent.keyDown(cellFor('Design'), { key: ' ' });
    expect(cellFor('Design')).toHaveAttribute('tabindex', '0');
    expect(selectTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Far jumps: scroll the target row into the virtualized window, then focus it
// ---------------------------------------------------------------------------

describe('ScheduleAriaOverlay far-jump scroll-into-view', () => {
  const MANY = Array.from({ length: 40 }, (_, i) => makeTask(`t${i}`, `Task ${i}`));

  it('scrolls down to reveal the last row on End, then focuses it once it mounts', () => {
    const { host } = mount({ tasks: MANY, clientHeight: 300 });
    fireEvent.keyDown(screen.getByRole('option', { name: /Task 0,/ }), { key: 'End' });

    // rowTop(39) + ROW_HEIGHT exceeds the viewport bottom, so the container is
    // scrolled just far enough to expose it.
    expect(host.scrollTop).toBe(39 * ROW_HEIGHT + ROW_HEIGHT - (300 - HEADER_HEIGHT));
    // The row only mounts once the container's scroll event re-derives the window.
    fireEvent.scroll(host);
    const last = screen.getByRole('option', { name: /Task 39,/ });
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute('tabindex', '0');
  });

  it('scrolls back up to the first row on Home', () => {
    const { host } = mount({ tasks: MANY, clientHeight: 300 });
    fireEvent.keyDown(screen.getByRole('option', { name: /Task 0,/ }), { key: 'End' });
    fireEvent.scroll(host);
    expect(host.scrollTop).toBeGreaterThan(0);

    fireEvent.keyDown(screen.getByRole('option', { name: /Task 39,/ }), { key: 'Home' });
    expect(host.scrollTop).toBe(0);
    fireEvent.scroll(host);
    expect(screen.getByRole('option', { name: /Task 0,/ })).toHaveFocus();
  });

  it('leaves the vertical scroll alone for a move already inside the window', () => {
    const { host } = mount({ tasks: MANY, clientHeight: 300 });
    fireEvent.keyDown(screen.getByRole('option', { name: /Task 0,/ }), { key: 'ArrowDown' });
    expect(host.scrollTop).toBe(0);
    expect(screen.getByRole('option', { name: /Task 1,/ })).toHaveFocus();
  });
});


/**
 * #2997 — the overlay derives its own virtualization window and its own row
 * rects. Both must resolve to the same pitch the canvas beneath is painting, or
 * the focus ring frames empty space and an AT reads a row set the user is not
 * looking at.
 */
describe('ScheduleAriaOverlay at the coarse row height (#2997)', () => {
  const MANY = Array.from({ length: 40 }, (_, i) => makeTask(`t${i}`, `Task ${i}`));

  afterEach(restoreCoarsePointer);

  it('narrows the virtualization window as rows get taller', () => {
    stubCoarsePointer(true);
    mount({ tasks: MANY, clientHeight: 300 });
    // Same viewport, taller rows → fewer rows fit. A window still computed at
    // 28 would mount rows the canvas has already scrolled past.
    const overscan = 5 * ROW_HEIGHT_COARSE;
    const lastRow = Math.min(39, Math.ceil((300 - 28 + overscan) / ROW_HEIGHT_COARSE));
    expect(screen.getAllByRole('option')).toHaveLength(lastRow + 1);
  });

  it('scrolls a far-jump target into view using the coarse pitch', () => {
    stubCoarsePointer(true);
    const { host } = mount({ tasks: MANY, clientHeight: 300 });
    fireEvent.keyDown(screen.getByRole('option', { name: /Task 0,/ }), { key: 'End' });
    expect(host.scrollTop).toBe(39 * ROW_HEIGHT_COARSE + ROW_HEIGHT_COARSE - (300 - 28));
  });

  it('places each row rect on the coarse pitch and centers its bar in it', () => {
    stubCoarsePointer(true);
    mount({ tasks: MANY.slice(0, 3), clientHeight: 300 });
    const rowWrapper = (n: number) =>
      screen.getByRole('option', { name: new RegExp(`Task ${n},`) })
        .parentElement as HTMLElement;
    expect(rowWrapper(0).style.top).toBe(`${28}px`);
    expect(rowWrapper(1).style.top).toBe(`${28 + ROW_HEIGHT_COARSE}px`);
    expect(rowWrapper(0).style.height).toBe(`${ROW_HEIGHT_COARSE}px`);
    // The bar's inset is derived, so it re-centers instead of hugging the top.
    const bar = screen.getByRole('option', { name: /Task 0,/ });
    expect(bar.style.top).toBe('13px');
  });
});

// #3060: the rail draws an empty sprint window precisely because the row bands
// structurally cannot; the canvas is aria-hidden, so without this the one fact
// the rail adds reaches a screen reader through nothing at all.
describe('emptySprintCadenceSentence (#3060)', () => {
  const win = (id: string, name: string, startDate: string, finishDate: string) => ({
    id,
    name,
    startDate,
    finishDate,
  });

  it('says nothing when every sprint has committed work', () => {
    expect(emptySprintCadenceSentence([])).toBeNull();
  });

  it('names the window and its DATES, not just the sprint', () => {
    expect(emptySprintCadenceSentence([win('s1', 'Sprint 5', '2026-04-06', '2026-04-17')])).toBe(
      'One sprint window has no committed work on this schedule: Sprint 5 (Apr 6 – Apr 17).',
    );
  });

  it('counts and lists several, in the order given', () => {
    expect(
      emptySprintCadenceSentence([
        win('s1', 'Sprint 5', '2026-04-06', '2026-04-17'),
        win('s2', 'Sprint 6', '2026-04-20', '2026-05-01'),
      ]),
    ).toBe(
      '2 sprint windows have no committed work on this schedule: Sprint 5 (Apr 6 – Apr 17), Sprint 6 (Apr 20 – May 1).',
    );
  });
});

describe('the chart description carries the empty-sprint sentence (#3060)', () => {
  afterEach(cleanup);

  const EMPTY = [
    { id: 's5', name: 'Sprint 5', startDate: '2026-04-06', finishDate: '2026-04-17' },
  ];

  function mountWith(emptySprints?: typeof EMPTY) {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientHeight', { value: 300, configurable: true });
    document.body.appendChild(host);
    render(
      <ScheduleAriaOverlay
        engine={null}
        tasks={TASKS}
        links={[]}
        emptySprints={emptySprints}
        containerRef={{ current: host } as RefObject<HTMLDivElement | null>}
      />,
    );
  }

  it('names the empty window inside the listbox’s own aria-describedby target', () => {
    mountWith(EMPTY);
    const grid = screen.getByRole('listbox', { name: 'Schedule chart' });
    // The listbox points at it, so a screen reader reads it on entering the chart
    // and browse mode can reach it — with NO new tab stop ahead of the rows.
    expect(grid).toHaveAttribute('aria-describedby', 'schedule-grid-help');
    expect(document.getElementById('schedule-grid-help')!.textContent).toContain(
      'One sprint window has no committed work on this schedule: Sprint 5 (Apr 6 – Apr 17).',
    );
  });

  it('adds no focusable stop — the option count is unchanged', () => {
    mountWith(EMPTY);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(TASKS.length);
    // Nothing focusable exists outside the rows.
    expect(document.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('says nothing at all when every sprint has committed work', () => {
    mountWith([]);
    expect(document.getElementById('schedule-grid-help')!.textContent).not.toContain(
      'no committed work',
    );
  });
});
