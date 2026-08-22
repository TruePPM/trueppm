/**
 * Unit coverage for the drag/keyboard preview overlay.
 *
 * Reworked in #2819 when the component gained a render site: it now takes the
 * live `GanttEngine` and the ordered task array (the same integration shape as
 * `ScheduleAriaOverlay`) rather than pre-resolved `scales`/`scrollLeft`/`taskIds`
 * props, and it positions ghost bars against the canvas timeline header.
 */
import { render, screen, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRef } from 'react';
import { PreviewOverlay } from './PreviewOverlay';
import { useDragStore } from '@/stores/dragStore';
import type { GanttEngine, GanttEngineEventMap, GanttScaleData } from '@/features/schedule/engine';
import type { DragPreviewResult, Task } from '@/types';
import { HEADER_HEIGHT } from './scheduleConstants';
import { BAR_TOP_OFFSET, ROW_HEIGHT } from './engine/GanttHitIndex';
import { stubCoarsePointer, restoreCoarsePointer } from '@/test/coarsePointer';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const SCALES: GanttScaleData = {
  start: new Date('2025-01-01T00:00:00Z'),
  end: new Date('2026-01-01T00:00:00Z'),
  totalWidth: 365 * 12,
  zoomLevel: 'week',
  pxPerMs: 12 / DAY_MS,
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId: 'p1',
    name: id.toUpperCase(),
    start: '2025-01-06',
    finish: '2025-01-10',
    duration: 5,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    ...overrides,
  } as Task;
}

/** Tasks in render order — row index is position in this array. */
const TASKS: Task[] = [makeTask('t1'), makeTask('t2'), makeTask('t3')];

/**
 * Minimal engine fake: exposes the three fields the overlay reads plus a
 * synchronous `on`. `scales: null` models the pre-mount engine.
 */
function makeEngine(opts: { scales?: GanttScaleData | null; scrollLeft?: number } = {}) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const fake = {
    scales: opts.scales === undefined ? SCALES : opts.scales,
    scrollLeft: opts.scrollLeft ?? 0,
    selectedTaskIds: new Set<string>(),
    on<K extends keyof GanttEngineEventMap>(
      event: K,
      handler: (payload: GanttEngineEventMap[K]) => void,
    ) {
      const set = listeners.get(event as string) ?? new Set();
      set.add(handler as (payload: unknown) => void);
      listeners.set(event as string, set);
      return () => set.delete(handler as (payload: unknown) => void);
    },
    /** Test helper — mirrors GanttEngineImpl's scroll emit. */
    emitScroll(scrollLeft: number) {
      fake.scrollLeft = scrollLeft;
      listeners.get('scroll')?.forEach((h) => h({ scrollLeft }));
    },
  };
  return fake as unknown as GanttEngine & { emitScroll: (scrollLeft: number) => void };
}

function container() {
  const ref = createRef<HTMLDivElement>();
  ref.current = document.createElement('div');
  return ref;
}

// A non-critical preview bar for t1
const NORMAL_RESULT: DragPreviewResult = {
  taskId: 't1',
  earlyStart: '2025-01-06',
  earlyFinish: '2025-01-10',
  isCritical: false,
  deltaDays: 2,
};

// A critical preview bar for t2
const CRITICAL_RESULT: DragPreviewResult = {
  taskId: 't2',
  earlyStart: '2025-01-13',
  earlyFinish: '2025-01-17',
  isCritical: true,
  deltaDays: 5,
};

const INITIAL_STORE = {
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
  useDragStore.setState(INITIAL_STORE);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Render with the standard fixtures; `opts` overrides the engine. */
function renderOverlay(opts: Parameters<typeof makeEngine>[0] = {}, tasks: Task[] = TASKS) {
  const engine = makeEngine(opts);
  const result = render(
    <PreviewOverlay engine={engine} tasks={tasks} containerRef={container()} />,
  );
  return { ...result, engine };
}

/** Every ghost bar in the overlay, regardless of which band div holds it. */
function dashedBars(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('div')).filter(
    (el) => el.style.borderStyle === 'dashed',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PreviewOverlay', () => {
  describe('visibility', () => {
    it('renders nothing when phase is idle', () => {
      const { container: c } = renderOverlay();
      expect(c.firstChild).toBeNull();
    });

    it('renders nothing when the engine has no scales yet', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([NORMAL_RESULT], null, 0);
      const { container: c } = renderOverlay({ scales: null });
      expect(c.firstChild).toBeNull();
    });

    it('renders nothing when the engine is null', () => {
      useDragStore.getState().startDrag('t1');
      const { container: c } = render(
        <PreviewOverlay engine={null} tasks={TASKS} containerRef={container()} />,
      );
      expect(c.firstChild).toBeNull();
    });

    it('renders when phase is dragging with scales', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([NORMAL_RESULT], null, 0);
      renderOverlay();
      expect(screen.getByTestId('preview-overlay')).toBeInTheDocument();
    });

    it('renders when phase is committing (animate-out)', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().commitDrag();
      const { container: c } = renderOverlay();
      expect(c.firstChild).not.toBeNull();
    });
  });

  describe('pointer events and accessibility (rule 27)', () => {
    it('root element is pointer-events-none and aria-hidden', () => {
      useDragStore.getState().startDrag('t1');
      const overlay = renderOverlay().container.firstChild as HTMLElement;
      expect(overlay).toHaveAttribute('aria-hidden', 'true');
      expect(overlay.className).toContain('pointer-events-none');
    });
  });

  describe('canvas alignment (#2819)', () => {
    it('offsets ghost bars below the timeline header', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([NORMAL_RESULT], null, 0);
      const overlay = renderOverlay().container.firstChild as HTMLElement;

      // The bars band is inset by the header height and clips to it, so a row
      // scrolled up under the header cannot paint over the date labels.
      const band = overlay.querySelector<HTMLElement>('div.overflow-hidden');
      expect(band).not.toBeNull();
      expect(band?.style.top).toBe(`${HEADER_HEIGHT}px`);

      // Row 0's bar sits at the renderer's own bar offset within that band —
      // NOT offset by the header a second time.
      const bar = band?.firstElementChild as HTMLElement;
      expect(bar.style.top).toBe(`${BAR_TOP_OFFSET}px`);
    });

    it('places a row-2 preview bar one ROW_HEIGHT per row down', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0); // t2 = row 1
      const overlay = renderOverlay().container.firstChild as HTMLElement;
      const bar = overlay.querySelector<HTMLElement>('div.overflow-hidden > div');
      expect(bar?.style.top).toBe(`${ROW_HEIGHT + BAR_TOP_OFFSET}px`);
    });

    it('re-positions horizontally when the engine scrolls', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([NORMAL_RESULT], null, 0);
      const { container: c, engine } = renderOverlay();
      const before = (c.querySelector('div.overflow-hidden > div') as HTMLElement).style.left;

      act(() => engine.emitScroll(120));

      const after = (c.querySelector('div.overflow-hidden > div') as HTMLElement).style.left;
      expect(Number.parseFloat(after)).toBeCloseTo(Number.parseFloat(before) - 120, 5);
    });
  });

  describe('animate-out (rule 33)', () => {
    it('has opacity 1 when dragging', () => {
      useDragStore.getState().startDrag('t1');
      const overlay = renderOverlay().container.firstChild as HTMLElement;
      expect(overlay.style.opacity).toBe('1');
    });

    it('transitions to opacity 0 when committing', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().commitDrag();
      const overlay = renderOverlay().container.firstChild as HTMLElement;
      expect(overlay.style.opacity).toBe('0');
      expect(overlay.style.transition).toContain('opacity');
    });
  });

  describe('CP badge delay (rule 26)', () => {
    it('does not show CP badge immediately on mount', () => {
      vi.useFakeTimers();
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0);
      renderOverlay();
      expect(screen.queryByText('CP')).toBeNull();
    });

    it('shows CP badge after 400 ms', () => {
      vi.useFakeTimers();
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0);
      renderOverlay();
      void act(() => vi.advanceTimersByTime(400));
      expect(screen.getByText('CP')).toBeInTheDocument();
    });

    it('does not show CP badge at 399 ms', () => {
      vi.useFakeTimers();
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0);
      renderOverlay();
      void act(() => vi.advanceTimersByTime(399));
      expect(screen.queryByText('CP')).toBeNull();
    });

    it('hides CP badge when drag ends', () => {
      vi.useFakeTimers();
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0);
      renderOverlay();
      void act(() => vi.advanceTimersByTime(400));
      expect(screen.getByText('CP')).toBeInTheDocument();

      void act(() => useDragStore.getState().cancelDrag());
      // Phase is idle → overlay not rendered → CP gone
      expect(screen.queryByText('CP')).toBeNull();
    });

    // Font floor (rule 50): text-[10px] is not permitted in features/schedule;
    // the CP badge must render at the text-xs (12px) legible floor (issue #1023).
    it('renders the CP badge at the text-xs floor, not text-[10px]', () => {
      vi.useFakeTimers();
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0);
      renderOverlay();
      void act(() => vi.advanceTimersByTime(400));
      const badge = screen.getByText('CP');
      expect(badge.className).toContain('text-xs');
      expect(badge.className).not.toContain('text-[10px]');
    });
  });

  describe('overflow label (rule 32)', () => {
    it('shows "+N more affected" when overflowCount > 0', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([NORMAL_RESULT], null, 7);
      renderOverlay();
      expect(screen.getByText('+7 more affected')).toBeInTheDocument();
    });

    it('hides the overflow label when overflowCount = 0', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([NORMAL_RESULT], null, 0);
      renderOverlay();
      expect(screen.queryByText(/more affected/)).toBeNull();
    });
  });

  describe('instruction strip (rules 28, 51)', () => {
    it('shows "Esc to cancel" for pointer drag', () => {
      useDragStore.getState().startDrag('t1'); // isKeyboard defaults to false
      renderOverlay();
      expect(screen.getByText('Esc to cancel')).toBeInTheDocument();
    });

    it('shows keyboard legend when isKeyboardMode is true (rule 51)', () => {
      useDragStore.getState().startDrag('t1', true);
      renderOverlay();
      expect(
        screen.getByText('← → Shift+arrow · d date · Enter confirm · Esc cancel'),
      ).toBeInTheDocument();
    });

    it('hides instruction strip when phase is committing', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().commitDrag();
      renderOverlay();
      expect(screen.queryByText('Esc to cancel')).toBeNull();
    });
  });

  describe('building phase ghost bar (#344)', () => {
    it('renders the overlay when phase is building', () => {
      useDragStore.getState().startBuilding('t1', '2025-01-06', '2025-01-10');
      const { container: c } = renderOverlay();
      expect(c.firstChild).not.toBeNull();
    });

    it('renders a dashed build ghost bar for the building task', () => {
      useDragStore.getState().startBuilding('t1', '2025-01-06', '2025-01-10');
      const overlay = renderOverlay().container.firstChild as HTMLElement;
      expect(dashedBars(overlay)).toHaveLength(1);
    });

    it('falls back to end-of-list row when buildingTaskId is not in tasks', () => {
      useDragStore.getState().startBuilding('t-new', '2025-01-06', '2025-01-10');
      const overlay = renderOverlay().container.firstChild as HTMLElement;
      const [bar] = dashedBars(overlay);
      expect(bar.style.top).toBe(`${TASKS.length * ROW_HEIGHT + BAR_TOP_OFFSET}px`);
    });
  });

  describe('origin ghost bar (rule 52)', () => {
    it('renders an origin bar at the dragged task position in keyboard mode', () => {
      useDragStore.getState().startDrag('t1', true);
      const overlay = renderOverlay().container.firstChild as HTMLElement;
      // Row 0 (t1), dashed border per rule 52.
      const [bar] = dashedBars(overlay);
      expect(bar).toBeDefined();
      expect(bar.style.top).toBe(`${BAR_TOP_OFFSET}px`);
    });

    it('does not render origin bar in pointer drag mode', () => {
      // The interaction canvas paints its own drag shadow for the bar under the
      // cursor, so a second ghost there would double it up.
      useDragStore.getState().startDrag('t1'); // pointer drag, isKeyboard = false
      const overlay = renderOverlay().container.firstChild as HTMLElement;
      expect(dashedBars(overlay)).toHaveLength(0);
    });

    it('renders no origin bar when the dragged task is not in the list', () => {
      useDragStore.getState().startDrag('t-gone', true);
      const overlay = renderOverlay().container.firstChild as HTMLElement;
      expect(dashedBars(overlay)).toHaveLength(0);
    });
  });

  describe('pinned-by-actuals disclosure (#2819)', () => {
    const PINNED = /Recorded actuals set this task's dates/;

    it('shows the estimate disclosure for an ordinary dragged task', () => {
      useDragStore.getState().startDrag('t1');
      renderOverlay();
      expect(screen.getByText('Preview — server confirms on drop')).toBeInTheDocument();
      expect(screen.queryByText(PINNED)).toBeNull();
    });

    it('explains that the drop will not move a task pinned by recorded actuals', () => {
      const tasks = [makeTask('t1', { isComplete: true, actualStart: '2025-01-06' }), ...TASKS.slice(1)];
      useDragStore.getState().startDrag('t1');
      renderOverlay({}, tasks);
      expect(screen.getByText(PINNED)).toBeInTheDocument();
      expect(screen.queryByText('Preview — server confirms on drop')).toBeNull();
    });

    it('pins on an actual FINISH alone, with no actual start', () => {
      const tasks = [makeTask('t1', { isComplete: true, actualFinish: '2025-01-10' }), ...TASKS.slice(1)];
      useDragStore.getState().startDrag('t1');
      renderOverlay({}, tasks);
      expect(screen.getByText(PINNED)).toBeInTheDocument();
    });

    it('does NOT treat a task complete by progress alone as pinned', () => {
      // Pinning is conditional on recorded actuals, not on completion: a task
      // complete by `progress` with no actuals IS still network-scheduled and
      // its drag genuinely moves it (#2819).
      const tasks = [
        makeTask('t1', { isComplete: true, progress: 100 }),
        ...TASKS.slice(1),
      ];
      useDragStore.getState().startDrag('t1');
      renderOverlay({}, tasks);
      expect(screen.queryByText(PINNED)).toBeNull();
      expect(screen.getByText('Preview — server confirms on drop')).toBeInTheDocument();
    });

    it('does not treat actuals on a not-yet-complete task as pinning', () => {
      const tasks = [makeTask('t1', { isComplete: false, actualStart: '2025-01-06' }), ...TASKS.slice(1)];
      useDragStore.getState().startDrag('t1');
      renderOverlay({}, tasks);
      expect(screen.queryByText(PINNED)).toBeNull();
    });

    it('carries the pinned state on a non-color channel as well as color', () => {
      // WCAG 1.4.1: the amber tone is a reinforcement, the sentence is the signal.
      const tasks = [makeTask('t1', { isComplete: true, actualStart: '2025-01-06' }), ...TASKS.slice(1)];
      useDragStore.getState().startDrag('t1');
      renderOverlay({}, tasks);
      const chip = screen.getByTestId('preview-disclosure');
      expect(chip.textContent).toMatch(PINNED);
      expect(chip.className).toContain('border-semantic-at-risk');
    });
  });
});


/**
 * #2997 — the ghost bar reads the same live bindings the renderer paints real
 * bars with, so it lands *on* the bar it previews rather than near it.
 *
 * The component's only change is a bare `useRowHeight()` whose return value is
 * discarded — an obvious candidate for a future "remove the unused call" edit.
 * Without it the overlay does not re-render on a pointer flip and the ghosts sit
 * at the old pitch over rows drawn at the new one, mid-drag.
 */
describe('PreviewOverlay at the coarse row height (#2997)', () => {
  afterEach(restoreCoarsePointer);

  it('places ghost bars on the 44px pitch with the derived inset', () => {
    stubCoarsePointer(true);
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0); // t2 = row 1
    const overlay = renderOverlay().container.firstChild as HTMLElement;
    const bar = overlay.querySelector<HTMLElement>('div.overflow-hidden > div');
    // 1 * 44 + (44 - 18) / 2 — a ghost still using the old 5px inset would sit
    // 8px above the bar it claims to preview.
    expect(bar?.style.top).toBe(`${44 + 13}px`);
  });

  it('follows a flip mid-session rather than keeping the pre-flip pitch', () => {
    const mq = stubCoarsePointer(false);
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0);
    const overlay = renderOverlay().container.firstChild as HTMLElement;
    expect(overlay.querySelector<HTMLElement>('div.overflow-hidden > div')?.style.top).toBe(
      `${28 + 5}px`,
    );

    act(() => mq.flip(true));

    // The component's only use of the hook is a bare subscription call. Delete
    // it and this assertion is the one thing that notices.
    expect(overlay.querySelector<HTMLElement>('div.overflow-hidden > div')?.style.top).toBe(
      `${44 + 13}px`,
    );
  });
});
