/**
 * Orchestrator-level coverage for the canvas Gantt engine (#784).
 *
 * The pure sub-components (GanttScaleData, GanttHitIndex, GanttPrimitives,
 * GanttRenderer, GanttDragFSM, GanttPanFSM) each have their own focused specs.
 * This suite exercises the `GanttEngineImpl` class that wires them together —
 * its public `GanttEngine` contract, which is the sole integration boundary
 * for the React shell (rule 54). We assert the observable, non-pixel behavior:
 * construction/teardown, the event emitter + unsubscribe (rule 55), selection
 * state, the continuous-zoom scale path (#351), and the scroll/fit math. Pixel
 * output is covered by the GanttRenderer draw-function specs; here the canvas
 * 2D context is a permissive recording spy so the rAF paint loop runs without
 * a real canvas (jsdom returns null from getContext — rule 79).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import { GanttEngineImpl } from './GanttEngineImpl';
import { CALENDAR_QUARTERS, ZOOM_CONFIGS, dateToLeft } from './GanttScaleData';
import { prepareDependencyLayout } from './GanttRenderer';

// Spy on the arrow-layout builder while keeping its real implementation, so
// #1499's regression test can assert *when* the dependency layout cache gets
// rebuilt without needing to reach into GanttEngineImpl's private state.
vi.mock('./GanttRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./GanttRenderer')>();
  return {
    ...actual,
    prepareDependencyLayout: vi.fn(actual.prepareDependencyLayout),
  };
});

// ---------------------------------------------------------------------------
// Fixtures + mocks
// ---------------------------------------------------------------------------

function makeTask(id: string, start: string, finish: string): Task {
  return {
    id,
    name: `Task ${id}`,
    start,
    finish,
    duration: 7,
    progress: 0,
    wbs: '1',
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
  };
}

/**
 * A permissive recording 2D context. Every draw call is a no-op spy so the
 * engine's paint pass runs to completion without a real canvas; `measureText`
 * returns a fixed width so label layout doesn't NaN.
 */
function makeCtx(): CanvasRenderingContext2D {
  const noop = () => vi.fn();
  const ctx = {
    save: noop(),
    restore: noop(),
    translate: noop(),
    rotate: noop(),
    scale: noop(),
    beginPath: noop(),
    closePath: noop(),
    moveTo: noop(),
    lineTo: noop(),
    rect: noop(),
    roundRect: noop(),
    arc: noop(),
    bezierCurveTo: noop(),
    quadraticCurveTo: noop(),
    fill: noop(),
    stroke: noop(),
    fillRect: noop(),
    clearRect: noop(),
    fillText: noop(),
    clip: noop(),
    setLineDash: noop(),
    measureText: vi.fn(() => ({ width: 20 }) as TextMetrics),
    // Settable style props the renderer writes — no-op getters/setters.
    set fillStyle(_v: string) {},
    get fillStyle() {
      return '';
    },
    set strokeStyle(_v: string) {},
    get strokeStyle() {
      return '';
    },
    set lineWidth(_v: number) {},
    set lineCap(_v: string) {},
    set textBaseline(_v: string) {},
    set font(_v: string) {},
    set globalAlpha(_v: number) {},
    canvas: null as unknown as HTMLCanvasElement,
  } as unknown as CanvasRenderingContext2D;
  return ctx;
}

function makeCanvas(ctx: CanvasRenderingContext2D | null): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.getContext = vi.fn(() => ctx) as unknown as HTMLCanvasElement['getContext'];
  if (ctx) (ctx as { canvas: HTMLCanvasElement }).canvas = el;
  return el;
}

function makeContainer(): { el: HTMLDivElement; scrollToSpy: ReturnType<typeof vi.fn> } {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  let scrollLeft = 0;
  let scrollTop = 0;
  Object.defineProperty(el, 'scrollLeft', {
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v;
    },
    configurable: true,
  });
  Object.defineProperty(el, 'scrollTop', {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });
  const scrollToSpy = vi.fn((opts: ScrollToOptions) => {
    if (opts && typeof opts.left === 'number') scrollLeft = opts.left;
  });
  el.scrollTo = scrollToSpy as unknown as HTMLDivElement['scrollTo'];
  return { el, scrollToSpy };
}

interface Harness {
  engine: GanttEngineImpl;
  container: HTMLDivElement;
  scrollToSpy: ReturnType<typeof vi.fn>;
  cancelRaf: ReturnType<typeof vi.fn>;
  roDisconnect: ReturnType<typeof vi.fn>;
  /** The recording 2D context backing the bars canvas — the layer dependency
   *  arrows and task bars paint onto. Exposed so the engine→renderer seam can be
   *  observed by inspecting the draw calls it received (issue 1515). */
  barsCtx: CanvasRenderingContext2D;
  /** Run the next scheduled rAF callback (drives exactly one engine tick). */
  flushFrame: () => void;
}

/**
 * Construct an engine with mocked canvas contexts and a controllable rAF loop.
 * `bgCtxNull` makes the bg canvas return a null context to exercise the
 * constructor's getContext-failure guard.
 */
function setup(opts?: { initialZoom?: 'day' | 'week' | 'month'; bgCtxNull?: boolean }): Harness {
  let nextFrame: FrameRequestCallback | null = null;
  let rafSeq = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    nextFrame = cb;
    return ++rafSeq;
  });
  const cancelRaf = vi.fn();
  vi.stubGlobal('cancelAnimationFrame', cancelRaf);

  const roDisconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = roDisconnect;
    },
  );

  const bgCanvas = makeCanvas(opts?.bgCtxNull ? null : makeCtx());
  const barsCtx = makeCtx();
  const barsCanvas = makeCanvas(barsCtx);
  const ixCanvas = makeCanvas(makeCtx());
  const { el: container, scrollToSpy } = makeContainer();

  const engine = new GanttEngineImpl({
    container,
    bgCanvas,
    barsCanvas,
    ixCanvas,
    initialZoom: opts?.initialZoom ?? 'day',
  });

  const flushFrame = (): void => {
    const cb = nextFrame;
    nextFrame = null;
    cb?.(0);
  };

  return { engine, container, scrollToSpy, cancelRaf, roDisconnect, barsCtx, flushFrame };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — construction', () => {
  it('throws when canvas.getContext("2d") returns null (rule 79 fallback signal)', () => {
    expect(() => setup({ bgCtxNull: true })).toThrow(/getContext/);
  });

  it('constructs with valid contexts; scales/pxPerDay are null until tasks arrive', () => {
    const { engine } = setup();
    expect(engine.scales).toBeNull();
    expect(engine.pxPerDay).toBeNull();
    expect(engine.selectedTaskIds.size).toBe(0);
  });

  it('builds a coordinate system synchronously on setTasks', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    expect(engine.scales).not.toBeNull();
    // Seeded from the initial 'day' tier.
    expect(engine.pxPerDay).toBe(ZOOM_CONFIGS.day.pxPerDay);
  });
});

// ---------------------------------------------------------------------------
// Event emitter (rule 55)
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — event emitter', () => {
  it('on() returns an unsubscribe that stops further delivery (rule 55)', () => {
    const { engine } = setup();
    const handler = vi.fn();
    const off = engine.on('selection-change', handler);

    engine.selectTask('a');
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    engine.selectTask('b');
    expect(handler).toHaveBeenCalledTimes(1); // no further delivery after unsubscribe
  });

  it('delivers the typed payload to every subscriber of an event', () => {
    const { engine } = setup();
    const a = vi.fn();
    const b = vi.fn();
    engine.on('selection-change', a);
    engine.on('selection-change', b);

    engine.selectTasks(['x', 'y']);

    expect(a).toHaveBeenCalledWith({ taskIds: ['x', 'y'] });
    expect(b).toHaveBeenCalledWith({ taskIds: ['x', 'y'] });
  });

  it('emits ready exactly once, after the first painted frame with scale data', () => {
    const { engine, flushFrame } = setup();
    const onReady = vi.fn();
    engine.on('ready', onReady);

    // No scales yet → a tick paints nothing and never fires ready.
    flushFrame();
    expect(onReady).not.toHaveBeenCalled();

    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0][0]).toHaveProperty('scales');

    flushFrame();
    expect(onReady).toHaveBeenCalledTimes(1); // never re-fires
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — selection', () => {
  it('selectTask sets a single-id selection and emits selection-change', () => {
    const { engine } = setup();
    const onSel = vi.fn();
    engine.on('selection-change', onSel);

    engine.selectTask('a');
    expect([...engine.selectedTaskIds]).toEqual(['a']);
    expect(onSel).toHaveBeenLastCalledWith({ taskIds: ['a'] });
  });

  it('selectTask(null) clears the selection', () => {
    const { engine } = setup();
    engine.selectTask('a');
    engine.selectTask(null);
    expect(engine.selectedTaskIds.size).toBe(0);
  });

  it('selectTasks replaces the whole selection set', () => {
    const { engine } = setup();
    engine.selectTasks(['a', 'b', 'c']);
    expect(engine.selectedTaskIds.size).toBe(3);
    engine.selectTasks(['d']);
    expect([...engine.selectedTaskIds]).toEqual(['d']);
  });
});

// ---------------------------------------------------------------------------
// Continuous zoom (#351)
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — zoom / scale', () => {
  it('setZoom routes through the continuous path and emits scales-change', () => {
    const { engine } = setup({ initialZoom: 'day' }); // seed pxPerDay = 40
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const onScales = vi.fn();
    engine.on('scales-change', onScales);

    engine.setZoom('week'); // → setPxPerDay(12)
    expect(engine.pxPerDay).toBe(ZOOM_CONFIGS.week.pxPerDay);
    expect(onScales).toHaveBeenCalledTimes(1);
  });

  it('setPxPerDay is a no-op (no re-emit) when already at the clamped target', () => {
    const { engine } = setup({ initialZoom: 'day' });
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const onScales = vi.fn();
    engine.on('scales-change', onScales);

    engine.setPxPerDay(ZOOM_CONFIGS.week.pxPerDay);
    expect(onScales).toHaveBeenCalledTimes(1);
    engine.setPxPerDay(ZOOM_CONFIGS.week.pxPerDay); // identical → suppressed
    expect(onScales).toHaveBeenCalledTimes(1);
  });

  it('exposes pxPerDay only once a coordinate system exists', () => {
    const { engine } = setup();
    expect(engine.pxPerDay).toBeNull();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    expect(engine.pxPerDay).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Viewport: scroll / fit
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — viewport', () => {
  it('scrollToDate scrolls the container, honoring the requested behavior', () => {
    const { engine, scrollToSpy } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);

    engine.scrollToDate('2026-04-15', 'smooth');
    expect(scrollToSpy).toHaveBeenCalledTimes(1);
    const arg = scrollToSpy.mock.calls[0][0] as ScrollToOptions;
    expect(arg.behavior).toBe('smooth'); // reduced-motion is off in the test env
    expect(typeof arg.left).toBe('number');
  });

  it('scrollToDate defaults to an instant jump', () => {
    const { engine, scrollToSpy } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    engine.scrollToDate('2026-04-15');
    expect((scrollToSpy.mock.calls[0][0] as ScrollToOptions).behavior).toBe('instant');
  });

  it('scrollToDate is a no-op before scales exist', () => {
    const { engine, scrollToSpy } = setup();
    engine.scrollToDate('2026-04-15');
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it('fitToProject rescales to the exact fit ratio and parks the start at the left inset', () => {
    const { engine, container } = setup({ initialZoom: 'day' });
    engine.setTasks([makeTask('a', '2026-04-01', '2026-12-31')]);
    engine.fitToProject();

    // Hand-derived from the source, NOT by re-calling the implementation's own
    // helpers. GanttEngineImpl._updateProjectRange pads the raw task span by
    // PAD_BEFORE = 30 days and PAD_AFTER = 90 days, so the fit operates on the
    // padded extent [2026-03-02, 2027-03-31] = 394 days. fitToProject computes
    // targetPxPerDay = (viewportWidth * 0.92) / spanDays; the ratio 736/394 ≈
    // 1.868 sits inside the [0.2, 40] continuous-zoom band, so clampPxPerDay is
    // the identity here and pxPerDay must equal the raw ratio exactly. A version
    // that divides by the span in milliseconds collapses to MIN 0.2 (microscopic
    // project) and a version that keeps the initial 'day' tier stays at 40 —
    // both fail this assertion. spanDays is derived from the documented padding
    // constants, not read back from the engine.
    const day = 86_400_000;
    const ts = (iso: string): number => Date.parse(iso + 'T00:00:00Z');
    const paddedStartIso = new Date(ts('2026-04-01') - 30 * day).toISOString().slice(0, 10);
    const paddedEndIso = new Date(ts('2026-12-31') + 90 * day).toISOString().slice(0, 10);
    const spanDays = Math.max(1, (ts(paddedEndIso) - ts(paddedStartIso)) / day);
    expect(spanDays).toBe(394); // pin the derivation so a padding-constant drift is loud
    const expectedPxPerDay = (800 * 0.92) / spanDays;
    expect(engine.pxPerDay).toBeCloseTo(expectedPxPerDay, 5);

    // scrollLeft parks the padded project start one inset (viewportWidth * 0.04)
    // in from x=0, so the leading pad doesn't sit flush against the gutter.
    // dateToLeft is a pinned linear transform (GanttScaleData.test.ts anchors it
    // to 0 at scales.start and asserts linearity), so calling it here reproduces
    // the target coordinate independently rather than mirroring fit math. A
    // version that inverts the inset sign, or scrolls to the project *end*, fails.
    const startX = dateToLeft(paddedStartIso, engine.scales!);
    expect(container.scrollLeft).toBeCloseTo(startX - 800 * 0.04, 0);
  });
});

// ---------------------------------------------------------------------------
// Mutation paths + misc setters (smoke: must paint without throwing)
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — mutations and setters', () => {
  it('setLinks, updateTask, setHoverChain, setFiscalConfig and setDark all repaint cleanly', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-11', '2026-04-20'),
    ]);
    flushFrame(); // initial paint + ready

    expect(() => {
      engine.setLinks([
        { id: 'l1', sourceId: 'a', targetId: 'b', type: 'FS' as const, lag: 0, isCritical: false },
      ]);
      engine.updateTask('a', { progress: 50 });
      engine.updateTask('missing', { progress: 10 }); // unknown id → early return
      engine.setHoverChain({
        hoveredId: 'a',
        predecessors: new Set<string>(),
        successors: new Set(['b']),
      });
      engine.setFiscalConfig(CALENDAR_QUARTERS);
      engine.setDark(true);
      flushFrame();
      flushFrame();
    }).not.toThrow();
  });

  it('cancelDrag with no active gesture emits nothing and does not throw', () => {
    const { engine } = setup();
    const onEnd = vi.fn();
    engine.on('drag-task-end', onEnd);
    engine.on('resize-task-end', onEnd);
    expect(() => engine.cancelDrag()).not.toThrow();
    expect(onEnd).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Engine → renderer seam (issue 1515): setLinks / updateTask must actually
// reach the painter. The smoke test above only proves they don't throw; these
// prove the stored data flows into the bars-layer paint pass. A no-op setLinks
// (arrows silently vanish) or an updateTask that never reaches the renderer
// (stale bars) would keep the smoke test green — these catch that.
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — setLinks / updateTask reach the renderer (issue 1515)', () => {
  // Scheduled tasks (plannedStart set) so prepareDependencyLayout builds real
  // anchor nodes and paintDependencyLayout actually strokes an FS polyline —
  // an unscheduled task is skipped as an arrow endpoint (GanttRenderer).
  function scheduled(id: string, start: string, finish: string): Task {
    return { ...makeTask(id, start, finish), plannedStart: start };
  }

  it('setLinks feeds the stored links into the layout and paints the arrow onto the bars canvas', () => {
    const { engine, container, barsCtx, flushFrame } = setup();
    const prepareSpy = vi.mocked(prepareDependencyLayout);
    // barsCtx.lineTo is a recording vi.fn from makeCtx(), not a real bound
    // method, so the unbound-method lint doesn't apply here.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const barsLineTo = vi.mocked(barsCtx.lineTo);

    engine.setTasks([scheduled('a', '2026-04-01', '2026-04-10'), scheduled('b', '2026-04-11', '2026-04-20')]);

    // The engine pads the project range 30 days before the earliest task, so at
    // the default 'day' zoom both bars sit ~1200px right of x=0 and paint entirely
    // off-screen (the arrow phase culls off-viewport paths). Scroll the first bar
    // near the left edge and sync the engine's scroll via a real scroll event so
    // the dependency pass actually reaches the bars canvas. dateToLeft is a pinned
    // linear transform (see GanttScaleData.test.ts).
    const barLeftA = dateToLeft('2026-04-01', engine.scales!);
    container.scrollLeft = Math.max(0, barLeftA - 100);
    container.dispatchEvent(new Event('scroll'));
    flushFrame(); // baseline paint — bars visible, still no links

    // Baseline: the most recent layout build was handed an empty link list, so
    // no dependency polyline has been stroked onto the bars canvas yet. (The
    // module-factory spy accumulates calls across tests, so this reads the last
    // in-window call rather than the whole history.)
    const prepareCallsBefore = prepareSpy.mock.calls.length;
    expect(prepareSpy.mock.calls.at(-1)![1]).toHaveLength(0);
    const lineToBefore = barsLineTo.mock.calls.length;

    engine.setLinks([
      { id: 'l1', sourceId: 'a', targetId: 'b', type: 'FS' as const, lag: 0, isCritical: false },
    ]);
    flushFrame();

    // Seam #1: the engine stored the link and handed that exact link to the
    // renderer's layout builder on a fresh build — a setLinks that dropped its
    // argument would still call the builder here with an empty array.
    expect(prepareSpy.mock.calls.length).toBeGreaterThan(prepareCallsBefore);
    const lastPrepareCall = prepareSpy.mock.calls.at(-1)!;
    expect(lastPrepareCall[1]).toHaveLength(1);
    expect(lastPrepareCall[1][0].id).toBe('l1');

    // Seam #2: the arrow was actually stroked onto the bars canvas — the painter
    // issued lineTo calls (Manhattan FS polyline) it had not issued before the
    // links existed.
    expect(barsLineTo.mock.calls.length).toBeGreaterThan(lineToBefore);
  });

  it('updateTask mutates the task the painter sees on the next tick', () => {
    const { engine, flushFrame } = setup();
    const prepareSpy = vi.mocked(prepareDependencyLayout);

    engine.setTasks([scheduled('a', '2026-04-01', '2026-04-10'), scheduled('b', '2026-04-11', '2026-04-20')]);
    engine.setLinks([
      { id: 'l1', sourceId: 'a', targetId: 'b', type: 'FS' as const, lag: 0, isCritical: false },
    ]);
    flushFrame();

    // Before: the painter saw task 'a' at progress 0.
    const taskABefore = prepareSpy.mock.calls.at(-1)![0].find((t) => t.id === 'a');
    expect(taskABefore?.progress).toBe(0);

    engine.updateTask('a', { progress: 50 });
    flushFrame();

    // After: updateTask replaced the task object and the paint pass fed the
    // mutated task list to the renderer — the seam carries the new value, so a
    // painter reading progress paints the 50%-filled bar. An updateTask that
    // never reached the renderer would leave the last-seen task at progress 0.
    const taskAAfter = prepareSpy.mock.calls.at(-1)![0].find((t) => t.id === 'a');
    expect(taskAAfter?.progress).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// #1499 — updateTask (drag preview) must not leave dependency arrows stale
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — updateTask repaints dependency arrows (#1499)', () => {
  it('rebuilds the dependency layout on the very next tick after updateTask, with no other trigger', () => {
    const { engine, flushFrame } = setup();
    const prepareSpy = vi.mocked(prepareDependencyLayout);

    engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-11', '2026-04-20'),
    ]);
    engine.setLinks([
      { id: 'l1', sourceId: 'a', targetId: 'b', type: 'FS' as const, lag: 0, isCritical: false },
    ]);
    flushFrame(); // initial full repaint — builds the layout cache once

    const callsAfterInitialPaint = prepareSpy.mock.calls.length;
    expect(callsAfterInitialPaint).toBeGreaterThan(0);

    // Simulate one live drag-preview frame: useScheduleCommit calls
    // engine.updateTask on every pointermove while dragging task 'a'.
    engine.updateTask('a', { start: '2026-04-02', finish: '2026-04-11' });
    flushFrame();

    // Before the #1499 fix, updateTask only added the row to `_dirtyRows`,
    // which routes the tick through `_paintRow` — a path that never calls
    // `prepareDependencyLayout` (it doesn't touch the bars-layer dependency
    // pass at all). This assertion catches that regression: the layout cache
    // must be rebuilt on the same tick the task patch is applied, not on some
    // later incidental full repaint.
    expect(prepareSpy.mock.calls.length).toBeGreaterThan(callsAfterInitialPaint);
  });

  it('does not fall back to the dirty-row-only paint path for a task patch', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-11', '2026-04-20'),
    ]);
    engine.setLinks([
      { id: 'l1', sourceId: 'a', targetId: 'b', type: 'FS' as const, lag: 0, isCritical: false },
    ]);
    flushFrame();

    // Internal-state assertion (Set) rather than a private-method spy — this
    // is the mechanism `updateTask` is documented to use post-fix. Cast through
    // `unknown` since `_barsRepaintPending`/`_dirtyRows` are private fields.
    engine.updateTask('a', { progress: 75 });
    const internals = engine as unknown as {
      _barsRepaintPending: boolean;
      _dirtyRows: Set<number>;
    };
    expect(internals._barsRepaintPending).toBe(true);
    expect(internals._dirtyRows.size).toBe(0);

    expect(() => flushFrame()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle / teardown
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — destroy', () => {
  it('cancels the rAF loop, disconnects the ResizeObserver, and clears handlers', () => {
    const { engine, cancelRaf, roDisconnect, flushFrame } = setup();
    const handler = vi.fn();
    engine.on('selection-change', handler);
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');

    engine.destroy();

    expect(cancelRaf).toHaveBeenCalled();
    expect(roDisconnect).toHaveBeenCalled();
    expect(removeWindowListener).toHaveBeenCalledWith('keydown', expect.any(Function));

    // Handlers are cleared — a later emit reaches no one.
    engine.selectTask('a');
    expect(handler).not.toHaveBeenCalled();

    // A scheduled tick after destroy is an immediate no-op.
    expect(() => flushFrame()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// #1524 — drag-task-move is coalesced to snapped-day changes
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — drag-task-move snapped-date coalescing (#1524)', () => {
  it('emits drag-task-move only when the snapped day changes, not per pointermove', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame();

    const moves: number[] = [];
    engine.on('drag-task-move', (ev) => moves.push(ev.left));

    // Drive _onPointerMove directly with a seeded FSM. jsdom has no
    // setPointerCapture and returns a zeroed getBoundingClientRect, so the full
    // pointerdown hit-test pipeline is not exercisable here — but _pointerToCanvas
    // maps clientX→canvasX 1:1 under those zeros, which is all the snap needs.
    const internals = engine as unknown as {
      _dragFSM: {
        onPointerDown: (id: string, x: number, y: number, p: number, t: 'move' | 'resize') => void;
      };
      _dragOffsetX: number;
      _onPointerMove: (e: PointerEvent) => void;
    };
    internals._dragOffsetX = 0;
    internals._dragFSM.onPointerDown('a', 300, 40, 1, 'move');

    const move = (clientX: number) =>
      internals._onPointerMove({ clientX, clientY: 40, pointerType: 'mouse' } as PointerEvent);

    move(340); // crosses the 4px threshold → FSM 'started', no emit
    move(340); // → 'moved' → first emit at snap(340)
    move(340); // identical x → identical snapped day → coalesced away
    expect(moves).toHaveLength(1);

    // A move a whole day away produces a distinct snapped date → emits again.
    const px = Math.ceil(engine.pxPerDay ?? 30);
    move(340 + px * 3);
    expect(moves).toHaveLength(2);
    expect(moves[1]).not.toBe(moves[0]);
  });

  it('resets the coalescing guard between drags so a new drag always emits its first move', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame();

    const moves: number[] = [];
    engine.on('drag-task-move', (ev) => moves.push(ev.left));

    const internals = engine as unknown as {
      _dragFSM: {
        onPointerDown: (id: string, x: number, y: number, p: number, t: 'move' | 'resize') => void;
        reset: () => void;
      };
      _dragOffsetX: number;
      _onPointerMove: (e: PointerEvent) => void;
    };
    internals._dragOffsetX = 0;

    const drag = () => {
      internals._dragFSM.onPointerDown('a', 300, 40, 1, 'move');
      internals._onPointerMove({ clientX: 340, clientY: 40, pointerType: 'mouse' } as PointerEvent);
      internals._onPointerMove({ clientX: 340, clientY: 40, pointerType: 'mouse' } as PointerEvent);
    };

    drag();
    engine.cancelDrag(); // ends the drag, clearing _lastEmittedDragX
    drag(); // same snapped x as the first drag — must still emit, guard was reset

    expect(moves).toHaveLength(2);
  });
});
