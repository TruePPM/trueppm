import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramSchedulePage } from './ProgramSchedulePage';
import { transformProgramSchedule } from './transformProgramSchedule';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/features/schedule/scheduleConstants';
import { GanttEngineStub } from '@/features/schedule/engine';
import { stubCoarsePointer, restoreCoarsePointer } from '@/test/coarsePointer';
import type { GanttEngine, GanttEngineEventMap, GanttScaleData } from '@/features/schedule/engine';
import type { ProgramSchedule, ProgramScheduleExternalTask } from '../hooks/useProgramSchedule';

const useProgramSchedule = vi.fn<() => unknown>();
vi.mock('../hooks/useProgramSchedule', async (orig) => {
  const actual = await orig<typeof import('../hooks/useProgramSchedule')>();
  return { ...actual, useProgramSchedule: () => useProgramSchedule() };
});

const useProgram = vi.fn<() => unknown>();
vi.mock('@/hooks/useProgram', () => ({ useProgram: () => useProgram() }));

const useBreakpoint = vi.fn(() => 'lg');
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => useBreakpoint() }));

/**
 * Fake coordinate system handed to the page through the engine. `totalWidth`
 * drives the scroll spacer's width, which is the only observable the page
 * derives from `engine.scales`.
 */
const SCALES: GanttScaleData = {
  start: new Date('2026-03-01T00:00:00Z'),
  end: new Date('2026-06-01T00:00:00Z'),
  totalWidth: 1280,
  zoomLevel: 'week',
  pxPerMs: 12 / 86_400_000,
};

const NARROWER_SCALES: GanttScaleData = { ...SCALES, totalWidth: 480 };

/**
 * Scriptable engine double. `GanttEngineStub` already satisfies the full
 * `GanttEngine` surface, so this only overrides the three members the page
 * actually touches: `scales`, `on` (so the test can fire engine events), and
 * `fitToProject` (so the fit-once effect and the Fit control are observable).
 */
class TestEngine extends GanttEngineStub {
  override readonly scales: GanttScaleData | null = SCALES;

  fitCalls = 0;

  /** #2997 — how many times the page told the canvas its row pitch moved. */
  rowMetricsCalls = 0;

  override rowMetricsChanged(): void {
    this.rowMetricsCalls += 1;
  }

  private readonly handlers = new Map<string, (payload: never) => void>();

  override on<K extends keyof GanttEngineEventMap>(
    event: K,
    handler: (payload: GanttEngineEventMap[K]) => void,
  ): () => void {
    this.handlers.set(event, handler as (payload: never) => void);
    return () => {
      this.handlers.delete(event);
    };
  }

  override fitToProject(): void {
    this.fitCalls += 1;
  }

  /** Fire a subscribed engine event, as the real renderer would. */
  emit<K extends keyof GanttEngineEventMap>(event: K, payload: GanttEngineEventMap[K]): void {
    const handler = this.handlers.get(event) as ((payload: GanttEngineEventMap[K]) => void) | undefined;
    handler?.(payload);
  }

  hasSubscriber(event: keyof GanttEngineEventMap): boolean {
    return this.handlers.has(event);
  }
}

/**
 * The engine the stubbed canvas hands back on mount. `null` (the default) means
 * "the canvas never became ready", which is the shape most chrome tests want.
 */
let activeEngine: TestEngine | null = null;

// Stub the canvas engine + live-sync sockets + zoom control — this is a
// chrome/state test, not a rendering test (the engine has its own coverage).
// The canvas stub still publishes `activeEngine` through `onEngineReady` so the
// engine-driven effects (fit-once, scales-change, task-hover) are exercisable.
vi.mock('@/features/schedule/CanvasScheduleTimeline', async () => {
  const { useEffect } = await import('react');
  return {
    CanvasScheduleTimeline: ({
      onEngineReady,
    }: {
      onEngineReady: (engine: GanttEngine) => void;
    }) => {
      useEffect(() => {
        if (activeEngine) onEngineReady(activeEngine);
      }, [onEngineReady]);
      return <div data-testid="canvas-timeline" />;
    },
  };
});

// Render the live-sync subscriber's inputs so the page→socket wiring is
// observable without opening a real WebSocket.
vi.mock('./ProgramScheduleLiveSync', () => ({
  ProgramScheduleLiveSync: ({
    programId,
    projectIds,
  }: {
    programId: string;
    projectIds: string[];
  }) => (
    <div
      data-testid="live-sync"
      data-program-id={programId}
      data-project-ids={projectIds.join(',')}
    />
  ),
}));

// The real ZoomControl owns its own zoom UI; here we only need its `onFit`
// escape hatch to be clickable.
vi.mock('@/features/schedule/ZoomControl', () => ({
  ZoomControl: ({ onFit }: { onFit: () => void }) => (
    <button type="button" data-testid="zoom-control" onClick={onFit}>
      Fit to program
    </button>
  ),
}));

function axiosError(status: number, data?: unknown): unknown {
  return { isAxiosError: true, response: { status, data } };
}

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    isRefetching: false,
    ...over,
  };
}

const GOLDEN: ProgramSchedule = {
  program_id: 'prog-1',
  start_date: '2026-03-02',
  finish_date: '2026-05-01',
  projects: [
    { id: 'proj-a', name: 'Helios Platform', accessible: true },
    { id: 'proj-b', name: 'Helios Mobile', accessible: true },
  ],
  tasks: [
    {
      id: 't-a1',
      name: 'Design API',
      hex_id: 'A-1',
      project_id: 'proj-a',
      is_milestone: false,
      is_external: false,
      wbs_path: '1.1',
      early_start: '2026-03-02',
      early_finish: '2026-03-13',
      late_start: '2026-03-02',
      late_finish: '2026-03-13',
      total_float_days: 0,
      is_critical: true,
    },
  ],
  links: [],
  critical_path: ['t-a1'],
  cross_project_edge_count: 0,
};

/** A redacted task in a member project the requester cannot read (ADR-0120 D5). */
const EXTERNAL_TASK: ProgramScheduleExternalTask = {
  id: 't-ext',
  title: 'Vendor certification',
  hex_id: 'B-7',
  project_id: 'proj-b',
  project_name: 'Helios Mobile',
  is_milestone: false,
  is_external: true,
  early_start: '2026-03-16',
  early_finish: '2026-03-27',
  is_critical: true,
};

const WITH_EXTERNAL: ProgramSchedule = {
  ...GOLDEN,
  tasks: [...GOLDEN.tasks, EXTERNAL_TASK],
};

function renderPage(initialPath = '/programs/prog-1/schedule') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/programs/:programId/schedule" element={<ProgramSchedulePage />} />
        {/* Same page mounted outside a program route — `useProgramId()` is undefined. */}
        <Route path="/schedule" element={<ProgramSchedulePage />} />
        {/* Navigation targets, so a click's destination is assertable. */}
        <Route path="/programs/:programId/projects" element={<div>Projects tab landed</div>} />
        <Route path="/projects/:projectId/schedule" element={<div>Project schedule landed</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProgramSchedulePage', () => {
  beforeEach(() => {
    activeEngine = null;
    useBreakpoint.mockReturnValue('lg');
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Helios' } });
  });

  it('shows a larger-screen notice on small viewports', () => {
    useBreakpoint.mockReturnValue('sm');
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    expect(screen.getByText('Best viewed on a larger screen')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-timeline')).not.toBeInTheDocument();
  });

  it('shows a loading skeleton while fetching', () => {
    useProgramSchedule.mockReturnValue(queryResult({ isLoading: true }));
    renderPage();
    expect(screen.getByLabelText('Loading program schedule')).toBeInTheDocument();
  });

  it('renders the golden path: header, project count, legend, and canvas', () => {
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    expect(screen.getByRole('heading', { name: 'Program Schedule' })).toBeInTheDocument();
    expect(screen.getByText(/Cross-project critical path across 2 projects/)).toBeInTheDocument();
    expect(screen.getByTestId('canvas-timeline')).toBeInTheDocument();
    expect(screen.getByText('Critical path')).toBeInTheDocument();
  });

  it('wraps the canvas in a scrollable container with a content-height spacer (issue 1624)', () => {
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    // The container the engine scrolls must be overflow-auto, or the browser
    // never fires `scroll` and the virtualizing engine stays pinned at row 0.
    const scroll = screen.getByTestId('program-schedule-canvas-scroll');
    expect(scroll.className).toContain('overflow-auto');
    // Its spacer child must be sized to every lane row so scrollHeight exceeds
    // the viewport — this is the regression the bug was missing.
    const spacer = scroll.firstElementChild as HTMLElement;
    const rowCount = transformProgramSchedule(GOLDEN).tasks.length;
    expect(rowCount).toBeGreaterThan(0);
    expect(spacer.style.height).toBe(`${HEADER_HEIGHT + rowCount * ROW_HEIGHT}px`);
  });

  it('shows the empty state when there are no scheduled tasks', () => {
    useProgramSchedule.mockReturnValue(queryResult({ data: { ...GOLDEN, tasks: [] } }));
    renderPage();
    expect(screen.getByText('No program schedule yet')).toBeInTheDocument();
  });

  it('falls back to the empty state for a defensive 409 (endpoint emits 200-empty, not 409)', () => {
    useProgramSchedule.mockReturnValue(queryResult({ error: axiosError(409) }));
    renderPage();
    expect(screen.getByText('No program schedule yet')).toBeInTheDocument();
  });

  it('shows the too-large panel for a 422', () => {
    useProgramSchedule.mockReturnValue(queryResult({ error: axiosError(422) }));
    renderPage();
    expect(screen.getByText('This program is too large to chart live')).toBeInTheDocument();
  });

  it('shows the invalid-input panel naming the offending project for a structured 422 (#1981)', () => {
    useProgramSchedule.mockReturnValue(
      queryResult({
        error: axiosError(422, {
          code: 'program_schedule_invalid_input',
          detail: 'A task in “Migration Tooling” has data the schedule engine cannot compute.',
          reason: 'three-point estimates must satisfy optimistic <= most_likely <= pessimistic',
          project: { id: 'proj-mig', name: 'Migration Tooling' },
          task: { id: 't-bad', name: 'Something' },
        }),
      }),
    );
    renderPage();
    expect(screen.getByText("A project's task data can't be scheduled")).toBeInTheDocument();
    expect(
      screen.getByText(/A task in “Migration Tooling” has an invalid estimate or dependency/),
    ).toBeInTheDocument();
    // Routes to the offending project's schedule, not a dead retry.
    expect(
      screen.getByRole('button', { name: /Open Migration Tooling schedule/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows a forbidden message for a 403', () => {
    useProgramSchedule.mockReturnValue(queryResult({ error: axiosError(403) }));
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/don.t have access/i);
  });

  it('shows a retryable error for a network/5xx failure', () => {
    useProgramSchedule.mockReturnValue(queryResult({ error: axiosError(500) }));
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t load the program schedule/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  // ----- Error-panel actions -------------------------------------------------

  it('refetches when Retry is clicked, and locks the button while a retry is in flight', async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    useProgramSchedule.mockReturnValue(queryResult({ error: axiosError(500), refetch }));
    const { unmount } = renderPage();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
    unmount();

    // While the retry is in flight the control reports progress and refuses a
    // second click rather than stacking requests.
    useProgramSchedule.mockReturnValue(
      queryResult({ error: axiosError(500), refetch, isRefetching: true }),
    );
    renderPage();
    const retrying = screen.getByRole('button', { name: 'Retrying…' });
    expect(retrying).toBeDisabled();
  });

  it('routes the too-large panel to the program Projects tab', async () => {
    const user = userEvent.setup();
    useProgramSchedule.mockReturnValue(queryResult({ error: axiosError(422) }));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Go to Projects' }));
    expect(screen.getByText('Projects tab landed')).toBeInTheDocument();
  });

  it('routes the invalid-input panel to the named project’s own schedule (#1981)', async () => {
    const user = userEvent.setup();
    useProgramSchedule.mockReturnValue(
      queryResult({
        error: axiosError(422, {
          code: 'program_schedule_invalid_input',
          detail: 'bad estimate',
          project: { id: 'proj-mig', name: 'Migration Tooling' },
        }),
      }),
    );
    renderPage();
    await user.click(screen.getByRole('button', { name: /Open Migration Tooling schedule/i }));
    expect(screen.getByText('Project schedule landed')).toBeInTheDocument();
  });

  it('still routes to the offending project when the 422 carries an id but no name', async () => {
    const user = userEvent.setup();
    useProgramSchedule.mockReturnValue(
      queryResult({
        error: axiosError(422, {
          code: 'program_schedule_invalid_input',
          detail: 'bad estimate',
          // Defensive: an older/partial server body with no project name.
          project: { id: 'proj-mig' },
        }),
      }),
    );
    renderPage();
    // The copy stays generic (no name to quote) but the route is still known.
    expect(
      screen.getByText(/A task in one of this program's projects has an invalid estimate/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open project schedule' }));
    expect(screen.getByText('Project schedule landed')).toBeInTheDocument();
  });

  it('falls back to a generic invalid-input message + Projects link when no project is named', async () => {
    const user = userEvent.setup();
    useProgramSchedule.mockReturnValue(
      queryResult({
        error: axiosError(422, {
          code: 'program_schedule_invalid_input',
          detail: 'unattributable engine failure',
        }),
      }),
    );
    renderPage();
    // No project in the payload → the copy must not invent a name.
    expect(
      screen.getByText(/A task in one of this program's projects has an invalid estimate/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open .* schedule/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Projects' }));
    expect(screen.getByText('Projects tab landed')).toBeInTheDocument();
  });

  it('routes the no-schedule empty state to the program Projects tab', async () => {
    const user = userEvent.setup();
    useProgramSchedule.mockReturnValue(queryResult({ data: { ...GOLDEN, tasks: [] } }));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Go to Projects' }));
    expect(screen.getByText('Projects tab landed')).toBeInTheDocument();
  });

  // ----- Header copy ---------------------------------------------------------

  it('uses the singular noun when the program has exactly one project', () => {
    useProgramSchedule.mockReturnValue(
      queryResult({
        data: { ...GOLDEN, projects: [{ id: 'proj-a', name: 'Helios Platform', accessible: true }] },
      }),
    );
    renderPage();
    expect(screen.getByText(/Cross-project critical path across 1 project/)).toBeInTheDocument();
    expect(screen.queryByText(/across 1 projects/)).not.toBeInTheDocument();
  });

  it('omits the date range when the payload has no computed start/finish', () => {
    useProgramSchedule.mockReturnValue(
      queryResult({ data: { ...GOLDEN, start_date: null, finish_date: null } }),
    );
    renderPage();
    expect(screen.getByText(/Cross-project critical path across 2 projects/)).toBeInTheDocument();
    expect(screen.queryByText(/–/)).not.toBeInTheDocument();
  });

  it('labels the view generically until the program record loads', () => {
    useProgram.mockReturnValue({ data: undefined });
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    expect(screen.getByLabelText('Program schedule')).toBeInTheDocument();
  });

  it('names the view after the loaded program', () => {
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    expect(screen.getByLabelText('Helios schedule')).toBeInTheDocument();
  });

  // ----- Redacted (external) tasks -------------------------------------------

  it('adds the limited-view legend item only when the payload carries redacted tasks', () => {
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    const { unmount } = renderPage();
    expect(screen.queryByText('Limited-view task')).not.toBeInTheDocument();
    unmount();

    useProgramSchedule.mockReturnValue(queryResult({ data: WITH_EXTERNAL }));
    renderPage();
    expect(screen.getByText('Limited-view task')).toBeInTheDocument();
  });

  // ----- Live-sync wiring ----------------------------------------------------

  it('subscribes the live-sync bridge to every member project', () => {
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    const sync = screen.getByTestId('live-sync');
    expect(sync).toHaveAttribute('data-program-id', 'prog-1');
    expect(sync).toHaveAttribute('data-project-ids', 'proj-a,proj-b');
  });

  it('degrades the live-sync program id to empty when mounted outside a program route', () => {
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage('/schedule');
    expect(screen.getByTestId('live-sync')).toHaveAttribute('data-program-id', '');
  });

  // ----- Engine wiring -------------------------------------------------------

  it('frames the whole program once the canvas engine is ready', async () => {
    const engine = new TestEngine();
    activeEngine = engine;
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    const { unmount } = renderPage();

    await waitFor(() => expect(engine.fitCalls).toBe(1));
    // A settled page must not keep re-framing (that would yank the viewport back
    // on every live refetch).
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(engine.fitCalls).toBe(1);

    unmount();
    // Both engine subscriptions are torn down with the page.
    expect(engine.hasSubscriber('scales-change')).toBe(false);
    expect(engine.hasSubscriber('task-hover')).toBe(false);
  });

  /**
   * #2997 — the canvas is imperative, so a pointer-class flip is not a render
   * for it.
   *
   * React re-renders the outline and the scroll spacer from the new row height
   * on its own. The engine repaints from an rAF loop that only re-arms when a
   * mutator marks it dirty, and its hit index bakes every row's `rowTop` at
   * build time — so without this call the canvas stays painted AND hit-tested at
   * the old pitch until some unrelated repaint lands. The symptom is not a
   * visual glitch; it is a tap opening the row above the one under the finger.
   */
  it('tells the engine when the pointer class moves the row pitch (#2997)', async () => {
    const engine = new TestEngine();
    activeEngine = engine;
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));

    const mq = stubCoarsePointer(false);
    try {
      renderPage();
      await waitFor(() => expect(engine.rowMetricsCalls).toBe(1)); // once on ready

      act(() => mq.flip(true));

      await waitFor(() => expect(engine.rowMetricsCalls).toBe(2));
      // And the DOM half moved with it, from the same value.
      const spacer = screen.getByTestId('program-schedule-canvas-scroll')
        .firstElementChild as HTMLElement;
      const rowCount = transformProgramSchedule(GOLDEN).tasks.length;
      expect(spacer.style.height).toBe(`${HEADER_HEIGHT + rowCount * 44}px`);
    } finally {
      restoreCoarsePointer();
    }
  });

  it('sizes the scroll spacer from the coarse row height (#2997)', () => {
    const mq = stubCoarsePointer(true);
    try {
      useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
      renderPage();
      const spacer = screen.getByTestId('program-schedule-canvas-scroll')
        .firstElementChild as HTMLElement;
      const rowCount = transformProgramSchedule(GOLDEN).tasks.length;
      // The spacer is the only thing making a long program's last rows
      // reachable — sized at 28 while rows paint at 44 truncates the plan.
      expect(spacer.style.height).toBe(`${HEADER_HEIGHT + rowCount * 44}px`);
    } finally {
      restoreCoarsePointer();
    }
    void mq;
  });

  it('re-frames the program when the Fit control is used', async () => {
    const user = userEvent.setup();
    const engine = new TestEngine();
    activeEngine = engine;
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    await waitFor(() => expect(engine.fitCalls).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Fit to program' }));
    expect(engine.fitCalls).toBe(2);
  });

  it('sizes the scroll spacer from the engine scales and tracks scale changes', async () => {
    const engine = new TestEngine();
    activeEngine = engine;
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();

    const spacer = screen.getByTestId('program-schedule-canvas-scroll')
      .firstElementChild as HTMLElement;
    await waitFor(() => expect(spacer.style.width).toBe('1280px'));

    // Zooming out rebuilds the scale — the spacer must follow, or the canvas
    // stops being horizontally scrollable at the new width.
    act(() => {
      engine.emit('scales-change', { scales: NARROWER_SCALES });
    });
    expect(spacer.style.width).toBe('480px');
  });

  it('falls back to a full-width spacer before the engine reports any scale', () => {
    // No engine → `totalCanvasWidth` stays 0 and the spacer must fill the
    // viewport rather than collapsing to 0px.
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    const spacer = screen.getByTestId('program-schedule-canvas-scroll')
      .firstElementChild as HTMLElement;
    expect(spacer.style.width).toBe('100%');
  });

  // ----- External-task hover card --------------------------------------------

  it('shows, follows, and dismisses the redacted-task hover card', async () => {
    const engine = new TestEngine();
    activeEngine = engine;
    useProgramSchedule.mockReturnValue(queryResult({ data: WITH_EXTERNAL }));
    renderPage();
    await waitFor(() => expect(engine.hasSubscriber('task-hover')).toBe(true));

    const scroll = screen.getByTestId('program-schedule-canvas-scroll');

    // Moving the pointer while nothing is hovered must not conjure a card.
    fireEvent.mouseMove(scroll, { clientX: 100, clientY: 80 });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      engine.emit('task-hover', { taskId: EXTERNAL_TASK.id });
    });
    const card = screen.getByRole('tooltip');
    expect(card).toHaveTextContent('Vendor certification');
    expect(card).toHaveTextContent('in Helios Mobile');
    expect(card).toHaveTextContent('On critical path');
    expect(card.style.left).toBe('112px');

    // The card tracks the cursor — the engine only re-fires on a task-id change.
    fireEvent.mouseMove(scroll, { clientX: 300, clientY: 200 });
    expect(screen.getByRole('tooltip').style.left).toBe('312px');

    // Hovering a task the requester CAN read shows no redaction card.
    act(() => {
      engine.emit('task-hover', { taskId: 't-a1' });
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // Re-show, then confirm the null task-id (pointer off every bar) clears it.
    act(() => {
      engine.emit('task-hover', { taskId: EXTERNAL_TASK.id });
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => {
      engine.emit('task-hover', { taskId: null });
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // Leaving the canvas entirely also clears a live card.
    act(() => {
      engine.emit('task-hover', { taskId: EXTERNAL_TASK.id });
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(scroll);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
