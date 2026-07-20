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
import { CALENDAR_QUARTERS, ZOOM_CONFIGS, dateToLeft, dateToRight } from './GanttScaleData';
import {
  drawRowBands,
  drawTimelineHeader,
  drawTimelineNameGutter,
  drawDragShadow,
  drawResizeIndicator,
  drawLinkPreview,
  drawMilestone,
  drawSummaryBar,
  drawActualDateBar,
  prepareDependencyLayout,
} from './GanttRenderer';

// Spy on the arrow-layout builder while keeping its real implementation, so
// #1499's regression test can assert *when* the dependency layout cache gets
// rebuilt without needing to reach into GanttEngineImpl's private state.
// drawTimelineHeader / drawRowBands are wrapped the same way so the issue-1523
// header-skip spec can assert *whether* the header date-walk ran on a given
// paint without inspecting private state.
vi.mock('./GanttRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./GanttRenderer')>();
  return {
    ...actual,
    prepareDependencyLayout: vi.fn(actual.prepareDependencyLayout),
    drawTimelineHeader: vi.fn(actual.drawTimelineHeader),
    drawRowBands: vi.fn(actual.drawRowBands),
    drawTimelineNameGutter: vi.fn(actual.drawTimelineNameGutter),
    // Interaction-layer + per-task draw fns wrapped (still call through to the
    // real impl) so the _paintInteraction / _paintTaskAt specs below can assert
    // *which* primitive a given gesture / task shape routes to, without pixels.
    drawDragShadow: vi.fn(actual.drawDragShadow),
    drawResizeIndicator: vi.fn(actual.drawResizeIndicator),
    drawLinkPreview: vi.fn(actual.drawLinkPreview),
    drawMilestone: vi.fn(actual.drawMilestone),
    drawSummaryBar: vi.fn(actual.drawSummaryBar),
    drawActualDateBar: vi.fn(actual.drawActualDateBar),
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
    strokeText: noop(),
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
  /** The recording 2D context backing the interaction canvas — the layer drag
   *  shadows/link previews paint onto. Exposed so the idle rAF loop's "final
   *  clear, then stop touching this canvas" contract (#1569) can be observed by
   *  inspecting `clearRect` call counts across ticks. */
  ixCtx: CanvasRenderingContext2D;
  /** Run the next scheduled rAF callback (drives exactly one engine tick). */
  flushFrame: () => void;
  /** True while a frame is armed (a prior tick called `requestAnimationFrame`
   *  and it has not been consumed by `flushFrame` yet) — the idle-loop
   *  contract (#1569) is that this goes false once nothing remains dirty. */
  hasScheduledFrame: () => boolean;
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
  const ixCtx = makeCtx();
  const ixCanvas = makeCanvas(ixCtx);
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

  const hasScheduledFrame = (): boolean => nextFrame !== null;

  return {
    engine,
    container,
    scrollToSpy,
    cancelRaf,
    roDisconnect,
    barsCtx,
    ixCtx,
    flushFrame,
    hasScheduledFrame,
  };
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

// ---------------------------------------------------------------------------
// issue 1523 — vertical-only scroll skips the header/grid date-walk
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — header repaint is skipped on vertical-only scroll (issue 1523)', () => {
  const headerSpy = vi.mocked(drawTimelineHeader);
  const bandSpy = vi.mocked(drawRowBands);

  it('repaints the bg body but not the timeline header when only scrollTop changes', () => {
    const { engine, container, flushFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame(); // initial full repaint draws the header at scrollLeft=0

    const headerBefore = headerSpy.mock.calls.length;
    const bandBefore = bandSpy.mock.calls.length;

    // Pure vertical scroll: scrollLeft is unchanged, scrollTop moves.
    container.scrollTop = 240;
    container.dispatchEvent(new Event('scroll'));
    flushFrame();

    // The header date-walk (major + minor rows) is the O(visible-days) cost the
    // audit flagged; it must NOT run — the prior header band is retained.
    expect(headerSpy.mock.calls.length).toBe(headerBefore);
    // The bg body still repaints, though: row bands and horizontal separators
    // move with scrollTop, so drawRowBands is called again.
    expect(bandSpy.mock.calls.length).toBeGreaterThan(bandBefore);
  });

  it('redraws the timeline header when scrollLeft changes (horizontal scroll)', () => {
    const { engine, container, flushFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame(); // header drawn at scrollLeft=0

    const headerBefore = headerSpy.mock.calls.length;

    // Horizontal scroll shifts every header cell — the walk must run again.
    container.scrollLeft = 320;
    container.dispatchEvent(new Event('scroll'));
    flushFrame();

    expect(headerSpy.mock.calls.length).toBeGreaterThan(headerBefore);
  });

  it('redraws the header on a fiscal-config change even when scrollLeft is unchanged', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame();

    const headerBefore = headerSpy.mock.calls.length;

    // Header labels/tiers depend on fiscal mode; content is dirty even though
    // scrollLeft did not move, so the walk must run.
    engine.setFiscalConfig({ mode: 'fiscal', startMonth: 3 });
    flushFrame();

    expect(headerSpy.mock.calls.length).toBeGreaterThan(headerBefore);
  });
});

// ---------------------------------------------------------------------------
// issue 1569 — idle rAF loop parks itself instead of repainting forever
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — idle rAF loop parks itself (#1569)', () => {
  it('stops rescheduling requestAnimationFrame once the initial full repaint settles', () => {
    const { engine, flushFrame, hasScheduledFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);

    // setTasks armed a frame for the initial full repaint.
    expect(hasScheduledFrame()).toBe(true);

    flushFrame();

    // Nothing is dirty and no gesture is active — the tick must NOT re-arm
    // itself. Before the #1569 fix, `_tick` unconditionally called
    // `requestAnimationFrame` at the end of every frame, so this would still
    // be scheduled here and the loop would spin at 60fps forever.
    expect(hasScheduledFrame()).toBe(false);
  });

  it('re-arms for a genuine repaint request, then parks again once it settles', () => {
    const { engine, container, flushFrame, hasScheduledFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame();
    expect(hasScheduledFrame()).toBe(false);

    // A horizontal scroll is a genuine reason to repaint (rows + header).
    container.scrollLeft = 320;
    container.dispatchEvent(new Event('scroll'));
    expect(hasScheduledFrame()).toBe(true);

    flushFrame();

    // Idle again — the scroll's own repaint doesn't leave anything pending.
    expect(hasScheduledFrame()).toBe(false);
  });

  it('clears the interaction canvas exactly once when a gesture ends, then stops touching it while idle', () => {
    const { engine, flushFrame, hasScheduledFrame, ixCtx } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame();
    expect(hasScheduledFrame()).toBe(false);

    // ixCtx.clearRect is a recording vi.fn from makeCtx(), not a real bound
    // method, so the unbound-method lint doesn't apply here.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const clearRect = vi.mocked(ixCtx.clearRect);
    const clearsBefore = clearRect.mock.calls.length;

    // Simulate the state right after a drag/pan/link gesture ends: the FSMs
    // are back to idle, but the interaction canvas still has last frame's
    // drag shadow / link preview on it (`_ixDirty`), and something (the
    // pointerup handler, in production) re-arms the loop for the cleanup
    // pass. `_ixDirty` and `_requestRepaint` are private; accessed the same
    // way other tests in this file reach FSM/dirty-flag internals.
    const internals = engine as unknown as {
      _ixDirty: boolean;
      _requestRepaint: () => void;
    };
    internals._ixDirty = true;
    internals._requestRepaint();
    expect(hasScheduledFrame()).toBe(true);

    flushFrame();

    // Exactly one more clearRect — the "final clear" the #1569 fix documents
    // (a "was drawn last frame" bit so the canvas is left blank, not one more
    // frame of paint-then-clear-then-paint).
    expect(clearRect.mock.calls.length).toBe(clearsBefore + 1);
    // No gesture is active and the canvas is now clean — the loop must park,
    // not keep clearing an already-empty canvas every frame.
    expect(hasScheduledFrame()).toBe(false);

    // A further no-op flush (nothing is scheduled) must not touch the canvas
    // again — this is the "idle Gantt must not clearRect the full viewport
    // every frame" regression #1569 fixed.
    flushFrame();
    expect(clearRect.mock.calls.length).toBe(clearsBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// Interaction internals — the pointer / keyboard / wheel handlers are private
// bound fields; the FSMs and hit-index they drive are already unit-tested, so
// here we reach the handlers the same way the existing #1524 spec does (a
// narrow internals cast) and assert the OBSERVABLE contract: which events the
// engine emits, and the cursor / scroll side-effects. jsdom returns a zeroed
// getBoundingClientRect, so `_pointerToCanvas` maps clientX/clientY 1:1 to
// canvas coords (scrollLeft/scrollTop default to 0) — coordinates below are
// therefore chosen straight from the hit-index geometry (HEADER_HEIGHT=28,
// ROW_HEIGHT=28, BAR_TOP_OFFSET=5, BAR_HEIGHT=18 → row 0 bar spans y∈[33,51]).
// ---------------------------------------------------------------------------

interface EngineInternals {
  _ixCanvas: HTMLCanvasElement;
  _pointerFine: boolean;
  _reducedMotion: boolean;
  _canvasHovered: boolean;
  _dragOffsetX: number;
  _onPointerDown: (e: PointerEvent) => void;
  _onPointerMove: (e: PointerEvent) => void;
  _onPointerUp: (e: PointerEvent) => void;
  _onPointerCancel: (e: PointerEvent) => void;
  _onPointerEnter: () => void;
  _onPointerLeave: () => void;
  _onDblClick: (e: MouseEvent) => void;
  _onWheel: (e: WheelEvent) => void;
  _onKeyDown: (e: KeyboardEvent) => void;
  _onKeyUp: (e: KeyboardEvent) => void;
  _onContextMenu: (e: MouseEvent) => void;
  _onResize: (entries: ResizeObserverEntry[]) => void;
  _onReducedMotionChange: (e: MediaQueryListEvent) => void;
  _onForcedColorsChange: (e: MediaQueryListEvent) => void;
  _linkFSM: { state: string };
  _panFSM: { state: string };
}

function internalsOf(engine: GanttEngineImpl): EngineInternals {
  return engine as unknown as EngineInternals;
}

/** Stub the pointer-capture calls jsdom's canvas element lacks. */
function stubPointerCapture(internals: EngineInternals): HTMLCanvasElement {
  const ix = internals._ixCanvas;
  ix.setPointerCapture = vi.fn();
  ix.releasePointerCapture = vi.fn();
  return ix;
}

function ptr(props: Partial<PointerEvent> & { clientX: number; clientY: number }): PointerEvent {
  return {
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    preventDefault: vi.fn(),
    ...props,
  } as unknown as PointerEvent;
}

/** Row-0 / row-1 bar geometry for the standard two-task fixture at day zoom. */
function barGeom(engine: GanttEngineImpl) {
  return {
    aLeft: dateToLeft('2026-04-01', engine.scales!),
    aRight: dateToRight('2026-04-10', engine.scales!),
    bLeft: dateToLeft('2026-04-11', engine.scales!),
    bRight: dateToRight('2026-04-20', engine.scales!),
  };
}

describe('GanttEngineImpl — bar drag gesture (pointer pipeline)', () => {
  it('emits drag-task on grab, drag-task-move across a day, and drag-task-end on release', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    stubPointerCapture(internals);
    const { aLeft } = barGeom(engine);

    const onStart = vi.fn();
    const onMove = vi.fn();
    const onEnd = vi.fn();
    engine.on('drag-task', onStart);
    engine.on('drag-task-move', onMove);
    engine.on('drag-task-end', onEnd);

    // Grab the bar body of row 0 (y=40 is inside [33,51] and below the header).
    internals._onPointerDown(ptr({ clientX: aLeft + 20, clientY: 40 }));
    expect(onStart).toHaveBeenCalledWith({ id: 'a' });
    // A grab that never moves emits no move.
    expect(onMove).not.toHaveBeenCalled();

    // Cross the 4px drag threshold, then move a further whole day so a distinct
    // snapped start date is emitted.
    const px = Math.ceil(engine.pxPerDay ?? 40);
    internals._onPointerMove(ptr({ clientX: aLeft + 30, clientY: 40 })); // → started
    internals._onPointerMove(ptr({ clientX: aLeft + 30 + px * 2, clientY: 40 })); // → moved
    expect(onMove).toHaveBeenCalled();
    expect(internals._ixCanvas.style.cursor).toBe('grabbing');

    internals._onPointerUp(ptr({ clientX: aLeft + 30 + px * 2, clientY: 40 }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0][0]).toHaveProperty('id', 'a');
    // A committed (non-cancelled) drag-end carries no `cancelled` flag.
    expect(onEnd.mock.calls[0][0]).not.toHaveProperty('cancelled', true);
    expect(internals._ixCanvas.style.cursor).toBe('default');
  });

  it('treats a grab-and-release with no movement as a click that selects the task', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    stubPointerCapture(internals);
    const { aLeft } = barGeom(engine);

    const onSel = vi.fn();
    const onEnd = vi.fn();
    engine.on('selection-change', onSel);
    engine.on('drag-task-end', onEnd);

    internals._onPointerDown(ptr({ clientX: aLeft + 20, clientY: 40 }));
    internals._onPointerUp(ptr({ clientX: aLeft + 20, clientY: 40 }));

    // HOVER_WAIT → up with no drag = click → selectTask, not a drag-end.
    expect([...engine.selectedTaskIds]).toEqual(['a']);
    expect(onSel).toHaveBeenLastCalledWith({ taskIds: ['a'] });
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('ignores pointerdown in the fixed header band (y < HEADER_HEIGHT)', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    stubPointerCapture(internals);
    const { aLeft } = barGeom(engine);

    const onStart = vi.fn();
    engine.on('drag-task', onStart);

    // y=10 is inside the 28px header band → the drag path is never entered.
    internals._onPointerDown(ptr({ clientX: aLeft + 20, clientY: 10 }));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('pointerdown on empty space (no hit zone) starts no gesture', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    stubPointerCapture(internals);

    const onStart = vi.fn();
    engine.on('drag-task', onStart);
    // Far left of the (padded) first bar → hit index returns null.
    internals._onPointerDown(ptr({ clientX: 2, clientY: 40 }));
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe('GanttEngineImpl — resize gesture (pointer pipeline)', () => {
  it('emits resize-task on grab of the right handle and resize-task-end on release', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    stubPointerCapture(internals);
    const { aRight } = barGeom(engine);

    const onResizeStart = vi.fn();
    const onResizeMove = vi.fn();
    const onResizeEnd = vi.fn();
    engine.on('resize-task', onResizeStart);
    engine.on('resize-task-move', onResizeMove);
    engine.on('resize-task-end', onResizeEnd);

    // Resize zone is [barRight-16, barRight+8] at bar height → clientX=aRight-4.
    internals._onPointerDown(ptr({ clientX: aRight - 4, clientY: 40 }));
    expect(onResizeStart).toHaveBeenCalledWith({ id: 'a' });

    internals._onPointerMove(ptr({ clientX: aRight + 10, clientY: 40 })); // started
    internals._onPointerMove(ptr({ clientX: aRight + 40, clientY: 40 })); // moved
    expect(onResizeMove).toHaveBeenCalled();
    expect(internals._ixCanvas.style.cursor).toBe('col-resize');

    internals._onPointerUp(ptr({ clientX: aRight + 40, clientY: 40 }));
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd.mock.calls[0][0]).toHaveProperty('id', 'a');
  });
});

describe('GanttEngineImpl — cancelDrag emits a cancelled end (#1666 guard path)', () => {
  it('emits drag-task-end with cancelled:true when a live drag is cancelled', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    stubPointerCapture(internals);
    const { aLeft } = barGeom(engine);

    const onEnd = vi.fn();
    engine.on('drag-task-end', onEnd);

    internals._onPointerDown(ptr({ clientX: aLeft + 20, clientY: 40 }));
    internals._onPointerMove(ptr({ clientX: aLeft + 40, clientY: 40 })); // → DRAGGING
    engine.cancelDrag();

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0][0]).toMatchObject({ id: 'a', cancelled: true });
  });

  it('pointercancel during a drag cancels it and emits a cancelled end', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    stubPointerCapture(internals);
    const { aLeft } = barGeom(engine);

    const onEnd = vi.fn();
    engine.on('drag-task-end', onEnd);

    internals._onPointerDown(ptr({ clientX: aLeft + 20, clientY: 40 }));
    internals._onPointerMove(ptr({ clientX: aLeft + 40, clientY: 40 }));
    internals._onPointerCancel(ptr({ clientX: aLeft + 40, clientY: 40 }));

    expect(onEnd.mock.calls[0][0]).toMatchObject({ cancelled: true });
  });
});

describe('GanttEngineImpl — hover cursor + task-hover emission (#475)', () => {
  it('emits task-hover with the id under the pointer and sets the grab cursor over a bar', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    const { aLeft } = barGeom(engine);

    const onHover = vi.fn();
    engine.on('task-hover', onHover);

    internals._onPointerMove(ptr({ clientX: aLeft + 20, clientY: 40 }));
    expect(onHover).toHaveBeenLastCalledWith({ taskId: 'a' });
    expect(internals._ixCanvas.style.cursor).toBe('grab');

    // A second move over the SAME bar does not re-emit (coalesced to id changes).
    onHover.mockClear();
    internals._onPointerMove(ptr({ clientX: aLeft + 22, clientY: 40 }));
    expect(onHover).not.toHaveBeenCalled();
  });

  it('emits task-hover null and resets the cursor when the pointer moves to empty space', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    const { aLeft } = barGeom(engine);

    const onHover = vi.fn();
    engine.on('task-hover', onHover);

    internals._onPointerMove(ptr({ clientX: aLeft + 20, clientY: 40 })); // over bar
    internals._onPointerMove(ptr({ clientX: 2, clientY: 40 })); // empty space

    expect(onHover).toHaveBeenLastCalledWith({ taskId: null });
    expect(internals._ixCanvas.style.cursor).toBe('default');
  });

  it('pointerleave clears a live hover and emits task-hover null', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    const { aLeft } = barGeom(engine);

    const onHover = vi.fn();
    engine.on('task-hover', onHover);

    internals._onPointerMove(ptr({ clientX: aLeft + 20, clientY: 40 }));
    onHover.mockClear();
    internals._onPointerLeave();

    expect(onHover).toHaveBeenCalledWith({ taskId: null });
  });

  it('pointerleave with no active hover does not re-emit task-hover', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);

    const onHover = vi.fn();
    engine.on('task-hover', onHover);
    internals._onPointerLeave();
    expect(onHover).not.toHaveBeenCalled();
  });
});

describe('GanttEngineImpl — double-click opens a task (#task-open)', () => {
  it('emits task-open for the task under the pointer', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    const { aLeft } = barGeom(engine);

    const onOpen = vi.fn();
    engine.on('task-open', onOpen);

    internals._onDblClick({ clientX: aLeft + 20, clientY: 40 } as MouseEvent);
    expect(onOpen).toHaveBeenCalledWith({ id: 'a' });
  });

  it('does not emit task-open when the double-click misses every bar', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);

    const onOpen = vi.fn();
    engine.on('task-open', onOpen);
    internals._onDblClick({ clientX: 2, clientY: 40 } as MouseEvent);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('is a no-op before scales/hit-index exist', () => {
    const { engine } = setup();
    const internals = internalsOf(engine);
    const onOpen = vi.fn();
    engine.on('task-open', onOpen);
    expect(() =>
      internals._onDblClick({ clientX: 100, clientY: 40 } as MouseEvent),
    ).not.toThrow();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('GanttEngineImpl — ctrl/cmd-wheel cursor-anchored zoom (#351)', () => {
  it('zooms in on ctrl+wheel-up and preventDefaults the browser page-zoom', () => {
    const { engine } = setup({ initialZoom: 'week' });
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    const internals = internalsOf(engine);
    const before = engine.pxPerDay!;

    const preventDefault = vi.fn();
    internals._onWheel({
      ctrlKey: true,
      metaKey: false,
      deltaY: -100,
      clientX: 200,
      preventDefault,
    } as unknown as WheelEvent);

    expect(preventDefault).toHaveBeenCalled();
    expect(engine.pxPerDay!).toBeGreaterThan(before); // zoom IN → more px/day
  });

  it('zooms out on cmd+wheel-down', () => {
    const { engine } = setup({ initialZoom: 'week' });
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    const internals = internalsOf(engine);
    const before = engine.pxPerDay!;

    internals._onWheel({
      ctrlKey: false,
      metaKey: true,
      deltaY: 120,
      clientX: 200,
      preventDefault: vi.fn(),
    } as unknown as WheelEvent);

    expect(engine.pxPerDay!).toBeLessThan(before);
  });

  it('leaves zoom untouched on a plain (no modifier) wheel', () => {
    const { engine } = setup({ initialZoom: 'week' });
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    const internals = internalsOf(engine);
    const before = engine.pxPerDay!;

    const preventDefault = vi.fn();
    internals._onWheel({
      ctrlKey: false,
      metaKey: false,
      deltaY: -100,
      clientX: 200,
      preventDefault,
    } as unknown as WheelEvent);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(engine.pxPerDay!).toBe(before);
  });
});

describe('GanttEngineImpl — Space-to-arm pan (#491)', () => {
  it('arms pan (cursor grab) on Space while hovered, and disarms on Space release', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);

    internals._onPointerEnter(); // scope the Space gesture to the canvas
    internals._onKeyDown({
      code: 'Space',
      key: ' ',
      repeat: false,
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(internals._ixCanvas.style.cursor).toBe('grab');

    internals._onKeyUp({ code: 'Space', key: ' ' } as unknown as KeyboardEvent);
    expect(internals._ixCanvas.style.cursor).toBe('default');
  });

  it('does not arm pan when Space is pressed while the canvas is not hovered', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);

    const preventDefault = vi.fn();
    internals._onKeyDown({
      code: 'Space',
      key: ' ',
      repeat: false,
      target: document.body,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(internals._ixCanvas.style.cursor).not.toBe('grab');
  });

  it('does not arm pan when Space is typed into an editable element', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    internals._onPointerEnter();

    const input = document.createElement('input');
    const preventDefault = vi.fn();
    internals._onKeyDown({
      code: 'Space',
      key: ' ',
      repeat: false,
      target: input,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(internals._ixCanvas.style.cursor).not.toBe('grab');
  });

  it('ignores auto-repeat Space keydown', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    internals._onPointerEnter();

    const preventDefault = vi.fn();
    internals._onKeyDown({
      code: 'Space',
      key: ' ',
      repeat: true,
      target: document.body,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('ignores non-Space keys', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    internals._onPointerEnter();
    internals._onKeyDown({
      code: 'KeyA',
      key: 'a',
      repeat: false,
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(internals._ixCanvas.style.cursor).not.toBe('grab');
  });
});

describe('GanttEngineImpl — middle-button drag-to-pan (#491)', () => {
  it('claims the gesture, pans the container on move, and suppresses the next context menu', () => {
    const { engine, container } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    const internals = internalsOf(engine);
    stubPointerCapture(internals);

    // Middle-button down pans immediately (no Space-arm step).
    internals._onPointerDown(ptr({ button: 1, clientX: 200, clientY: 100 }));
    expect(internals._ixCanvas.style.cursor).toBe('grabbing');
    expect(internals._panFSM.state).toBe('PANNING');

    // Drag the content left→right: pointer moves from x=200 to x=150 (dx=-50),
    // so scrollLeft increases by 50 (drag content right reveals earlier dates).
    internals._onPointerMove(ptr({ button: 1, clientX: 150, clientY: 100 }));
    expect(container.scrollLeft).toBe(50);

    internals._onPointerUp(ptr({ button: 1, clientX: 150, clientY: 100 }));
    expect(internals._panFSM.state).toBe('IDLE');

    // The synthetic contextmenu that a middle-button release fires is suppressed once.
    const preventDefault = vi.fn();
    internals._onContextMenu({ preventDefault } as unknown as MouseEvent);
    expect(preventDefault).toHaveBeenCalled();

    // A subsequent contextmenu (no pan) is NOT suppressed.
    const preventDefault2 = vi.fn();
    internals._onContextMenu({ preventDefault: preventDefault2 } as unknown as MouseEvent);
    expect(preventDefault2).not.toHaveBeenCalled();
  });

  it('pointercancel resets an active pan', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    const internals = internalsOf(engine);
    stubPointerCapture(internals);

    internals._onPointerDown(ptr({ button: 1, clientX: 200, clientY: 100 }));
    expect(internals._panFSM.state).toBe('PANNING');
    internals._onPointerCancel(ptr({ button: 1, clientX: 200, clientY: 100 }));
    expect(internals._panFSM.state).toBe('IDLE');
  });
});

describe('GanttEngineImpl — drag-to-link gesture (#1666)', () => {
  function twoTasks(engine: GanttEngineImpl) {
    engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-11', '2026-04-20'),
    ]);
  }

  it('arms on a link-dot, follows to a valid target, and emits create-link on drop', () => {
    const { engine } = setup();
    twoTasks(engine);
    const internals = internalsOf(engine);
    internals._pointerFine = true; // jsdom matchMedia reports (pointer: fine) = false
    stubPointerCapture(internals);
    const { aRight, bLeft } = barGeom(engine);

    const onCreate = vi.fn();
    engine.on('create-link', onCreate);

    // Link-dot of row 0 is [aRight+8, aRight+16] at row-0 bar height (y∈[33,51]).
    internals._onPointerDown(ptr({ clientX: aRight + 12, clientY: 40 }));
    expect(internals._linkFSM.state).toBe('ARMED');

    // Move onto task b's bar body in row 1 (y∈[61,79]); crosses the 4px threshold.
    internals._onPointerMove(ptr({ clientX: bLeft + 20, clientY: 70 }));
    expect(internals._linkFSM.state).toBe('DRAGGING');
    expect(internals._ixCanvas.style.cursor).toBe('crosshair');

    // Drop over the valid target → the source→target link is committed.
    internals._onPointerUp(ptr({ clientX: bLeft + 20, clientY: 70 }));
    expect(onCreate).toHaveBeenCalledWith({ sourceId: 'a', targetId: 'b' });
    expect(internals._linkFSM.state).toBe('IDLE');
  });

  it('drop over empty space is a silent cancel — no create-link', () => {
    const { engine } = setup();
    twoTasks(engine);
    const internals = internalsOf(engine);
    internals._pointerFine = true;
    stubPointerCapture(internals);
    const { aRight } = barGeom(engine);

    const onCreate = vi.fn();
    engine.on('create-link', onCreate);

    internals._onPointerDown(ptr({ clientX: aRight + 12, clientY: 40 }));
    internals._onPointerMove(ptr({ clientX: 3, clientY: 300 })); // drag to empty space
    expect(internals._ixCanvas.style.cursor).toBe('crosshair');
    internals._onPointerUp(ptr({ clientX: 3, clientY: 300 }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(internals._linkFSM.state).toBe('IDLE');
  });

  it('shows a not-allowed cursor when hovering back over the source bar', () => {
    const { engine } = setup();
    twoTasks(engine);
    const internals = internalsOf(engine);
    internals._pointerFine = true;
    stubPointerCapture(internals);
    const { aLeft, aRight } = barGeom(engine);

    internals._onPointerDown(ptr({ clientX: aRight + 12, clientY: 40 }));
    // Cross threshold first, then hover over the SOURCE bar body (self-link).
    internals._onPointerMove(ptr({ clientX: aRight + 20, clientY: 40 }));
    internals._onPointerMove(ptr({ clientX: aLeft + 20, clientY: 40 }));
    expect(internals._ixCanvas.style.cursor).toBe('not-allowed');
  });

  it('Escape cancels an in-progress link drag silently', () => {
    const { engine } = setup();
    twoTasks(engine);
    const internals = internalsOf(engine);
    internals._pointerFine = true;
    stubPointerCapture(internals);
    const { aRight, bLeft } = barGeom(engine);

    const onCreate = vi.fn();
    engine.on('create-link', onCreate);

    internals._onPointerDown(ptr({ clientX: aRight + 12, clientY: 40 }));
    internals._onPointerMove(ptr({ clientX: bLeft + 20, clientY: 70 }));
    internals._onKeyDown({ key: 'Escape' } as unknown as KeyboardEvent);

    expect(internals._linkFSM.state).toBe('IDLE');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('does not arm a link on a coarse pointer (touch reaches the picker drawer instead)', () => {
    const { engine } = setup();
    twoTasks(engine);
    const internals = internalsOf(engine);
    internals._pointerFine = false; // coarse pointer
    stubPointerCapture(internals);
    const { aRight } = barGeom(engine);

    internals._onPointerDown(ptr({ clientX: aRight + 12, clientY: 40 }));
    expect(internals._linkFSM.state).toBe('IDLE');
  });
});

describe('GanttEngineImpl — chart presentation toggles (#2097)', () => {
  it('paints the frozen name gutter only when showNameGutter is enabled', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame(); // default options: showNameGutter=false

    const gutterSpy = vi.mocked(drawTimelineNameGutter);
    const before = gutterSpy.mock.calls.length;

    engine.setChartOptions({
      taskNamePlacement: 'next',
      showProgressPills: true,
      showNameGutter: false,
    });
    flushFrame();
    expect(gutterSpy.mock.calls.length).toBe(before); // still off → not drawn

    engine.setChartOptions({
      taskNamePlacement: 'next',
      showProgressPills: true,
      showNameGutter: true,
    });
    flushFrame();
    expect(gutterSpy.mock.calls.length).toBeGreaterThan(before); // on → drawn
  });
});

describe('GanttEngineImpl — resize observer + accessibility media queries', () => {
  it('re-lays out and re-emits scales-change when the viewport size changes', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);

    const onScales = vi.fn();
    engine.on('scales-change', onScales);

    internals._onResize([
      { contentRect: { width: 1200, height: 900 } },
    ] as unknown as ResizeObserverEntry[]);

    expect(onScales).toHaveBeenCalledTimes(1);
    expect(onScales.mock.calls[0][0]).toHaveProperty('scales');
  });

  it('ignores a resize entry whose dimensions did not actually change', () => {
    const { engine, container } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);

    const onScales = vi.fn();
    engine.on('scales-change', onScales);

    // container was seeded at 800x600 in the harness — a matching entry is a no-op.
    internals._onResize([
      { contentRect: { width: container.clientWidth, height: container.clientHeight } },
    ] as unknown as ResizeObserverEntry[]);

    expect(onScales).not.toHaveBeenCalled();
  });

  it('honors prefers-reduced-motion for scrollToDate after a media-query change', () => {
    const { engine, scrollToSpy } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    const internals = internalsOf(engine);

    // Flip reduced-motion on via the live media-query handler.
    internals._onReducedMotionChange({ matches: true } as MediaQueryListEvent);
    engine.scrollToDate('2026-04-15', 'smooth');

    // Smooth requested, but reduced-motion downgrades it to an instant jump.
    expect((scrollToSpy.mock.calls[0][0] as ScrollToOptions).behavior).toBe('instant');
  });

  it('forced-colors change forces a repaint (re-arms the parked rAF loop)', () => {
    const { engine, flushFrame, hasScheduledFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame();
    expect(hasScheduledFrame()).toBe(false); // idle/parked

    const internals = internalsOf(engine);
    internals._onForcedColorsChange({ matches: true } as MediaQueryListEvent);

    // The palette switch schedules a full repaint on the next frame.
    expect(hasScheduledFrame()).toBe(true);
    expect(() => flushFrame()).not.toThrow();
  });
});

describe('GanttEngineImpl — project range from task dates', () => {
  it('falls back to a ±window around today when every task is unscheduled', () => {
    const { engine } = setup();
    const unscheduled: Task = { ...makeTask('u', '', ''), start: '', finish: '' };
    // No dated tasks → _updateProjectRange takes the today-centered branch; the
    // engine must still build a valid coordinate system rather than NaN out.
    expect(() => engine.setTasks([unscheduled])).not.toThrow();
    expect(engine.scales).not.toBeNull();
    expect(engine.pxPerDay).toBeGreaterThan(0);
  });

  it('setTasks([]) builds scales from the default range without throwing', () => {
    const { engine } = setup();
    expect(() => engine.setTasks([])).not.toThrow();
    expect(engine.scales).not.toBeNull();
  });

  it('fitToProject before any tasks/scales is a safe no-op', () => {
    const { engine } = setup();
    expect(() => engine.fitToProject()).not.toThrow();
    expect(engine.scales).toBeNull();
  });

  it('widens the project range to span the earliest start and latest finish across all tasks', () => {
    const { engine } = setup();
    // Deliberately out of chronological order and overlapping: the widening loop
    // in _updateProjectRange must track the global min-start / max-finish, not
    // just the first task's dates. Task 'c' has the earliest start; 'b' the
    // latest finish. dateToLeft is a pinned linear transform anchored at
    // scales.start, so an earlier start pushes scales.start earlier (padded 30d)
    // and a later finish pushes scales.end later (padded 90d).
    engine.setTasks([
      makeTask('a', '2026-06-01', '2026-06-10'),
      makeTask('b', '2026-06-05', '2026-09-30'), // latest finish
      makeTask('c', '2026-02-01', '2026-02-15'), // earliest start
    ]);
    // The widening loop must track the GLOBAL min-start / max-finish, not the
    // first task's dates. If it only used task 'a', the earliest-start task 'c'
    // (Feb) would land at a NEGATIVE x (left of the scale origin). dateToLeft is
    // a pinned linear transform anchored at scales.start, so 'c' sitting at a
    // non-negative x within the extent proves the loop pushed scales.start back
    // to cover it. Likewise the latest-finish task 'b' must extend furthest right.
    const cStartX = dateToLeft('2026-02-01', engine.scales!);
    const aStartX = dateToLeft('2026-06-01', engine.scales!);
    expect(cStartX).toBeGreaterThanOrEqual(0); // earliest task is inside the extent
    expect(cStartX).toBeLessThan(aStartX); // …and left of the first task
    expect(dateToRight('2026-09-30', engine.scales!)).toBeGreaterThan(
      dateToRight('2026-06-10', engine.scales!),
    );
  });

  it('exposes the live scrollLeft through the getter after a scroll event', () => {
    const { engine, container } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    expect(engine.scrollLeft).toBe(0);
    container.scrollLeft = 275;
    container.dispatchEvent(new Event('scroll'));
    expect(engine.scrollLeft).toBe(275);
  });
});

// ---------------------------------------------------------------------------
// Interaction-canvas paint pass (_paintInteraction) — drag shadow, resize
// indicator, and drag-to-link preview. These only paint while a gesture is
// live and the rAF tick runs, so each test drives the gesture through the
// pointer pipeline and THEN flushes a frame to force the interaction paint.
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — interaction-canvas paint (drag / resize / link preview)', () => {
  it('draws the drag shadow on the interaction layer while a bar drag is live', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame(); // settle the initial paint
    const internals = internalsOf(engine);
    stubPointerCapture(internals);
    const { aLeft } = barGeom(engine);
    const shadowSpy = vi.mocked(drawDragShadow);
    const before = shadowSpy.mock.calls.length;

    internals._onPointerDown(ptr({ clientX: aLeft + 20, clientY: 40 }));
    internals._onPointerMove(ptr({ clientX: aLeft + 40, clientY: 40 })); // → DRAGGING
    flushFrame(); // gesture is active → the tick paints the interaction layer

    expect(shadowSpy.mock.calls.length).toBeGreaterThan(before);
    // The shadow is drawn for the dragged task at its row index (0).
    const lastCall = shadowSpy.mock.calls.at(-1)!;
    expect(lastCall[1]).toHaveProperty('id', 'a'); // task arg
    expect(lastCall[3]).toBe(0); // rowIndex arg
  });

  it('draws the resize indicator on the interaction layer while a resize is live', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame();
    const internals = internalsOf(engine);
    stubPointerCapture(internals);
    const { aRight } = barGeom(engine);
    const resizeSpy = vi.mocked(drawResizeIndicator);
    const before = resizeSpy.mock.calls.length;

    internals._onPointerDown(ptr({ clientX: aRight - 4, clientY: 40 })); // resize handle
    internals._onPointerMove(ptr({ clientX: aRight + 30, clientY: 40 })); // → RESIZING
    flushFrame();

    expect(resizeSpy.mock.calls.length).toBeGreaterThan(before);
  });

  it('draws the link preview UNSNAPPED while dragging a link over empty space', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-11', '2026-04-20'),
    ]);
    flushFrame();
    const internals = internalsOf(engine);
    internals._pointerFine = true;
    stubPointerCapture(internals);
    const { aRight } = barGeom(engine);
    const previewSpy = vi.mocked(drawLinkPreview);
    const before = previewSpy.mock.calls.length;

    internals._onPointerDown(ptr({ clientX: aRight + 12, clientY: 40 })); // arm link
    internals._onPointerMove(ptr({ clientX: 3, clientY: 300 })); // drag to empty space
    flushFrame();

    expect(previewSpy.mock.calls.length).toBeGreaterThan(before);
    // No target under an empty-space drag → the preview is not snapped.
    expect(previewSpy.mock.calls.at(-1)![1]).toMatchObject({ snapped: false });
  });

  it('draws the link preview SNAPPED with a target ring while over a valid target bar', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-11', '2026-04-20'),
    ]);
    flushFrame();
    const internals = internalsOf(engine);
    internals._pointerFine = true;
    stubPointerCapture(internals);
    const { aRight, bLeft } = barGeom(engine);
    const previewSpy = vi.mocked(drawLinkPreview);

    internals._onPointerDown(ptr({ clientX: aRight + 12, clientY: 40 })); // arm link
    internals._onPointerMove(ptr({ clientX: bLeft + 20, clientY: 70 })); // onto target b
    flushFrame();

    const snap = previewSpy.mock.calls.at(-1)![1];
    expect(snap.snapped).toBe(true);
    // A snapped preview carries the target-bar highlight ring.
    expect(snap.targetRing).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _paintTaskAt shape branches — milestone / summary bars, the actual-date
// overlay, hover-chain dimming, and the unscheduled-row early return. All are
// reached from a single full-repaint frame over a mixed-shape task list.
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — task shape rendering (_paintTaskAt branches)', () => {
  function milestone(id: string, date: string): Task {
    return { ...makeTask(id, date, date), isMilestone: true };
  }
  function summary(id: string, start: string, finish: string): Task {
    return { ...makeTask(id, start, finish), isSummary: true };
  }
  function withActuals(id: string, start: string, finish: string): Task {
    return { ...makeTask(id, start, finish), actualStart: start, actualFinish: finish };
  }

  it('routes milestone, summary and actual-date tasks to their dedicated painters', () => {
    const { engine, flushFrame } = setup();
    const milestoneSpy = vi.mocked(drawMilestone);
    const summarySpy = vi.mocked(drawSummaryBar);
    const actualSpy = vi.mocked(drawActualDateBar);
    const mBefore = milestoneSpy.mock.calls.length;
    const sBefore = summarySpy.mock.calls.length;
    const aBefore = actualSpy.mock.calls.length;

    engine.setTasks([
      milestone('m', '2026-04-05'),
      summary('s', '2026-04-01', '2026-04-30'),
      withActuals('t', '2026-04-10', '2026-04-20'),
      // An unscheduled row (no start/finish) exercises the _paintTaskAt early
      // return without derailing the paint of the rows around it.
      { ...makeTask('u', '', ''), start: '', finish: '' },
    ]);
    flushFrame();

    expect(milestoneSpy.mock.calls.length).toBeGreaterThan(mBefore);
    expect(summarySpy.mock.calls.length).toBeGreaterThan(sBefore);
    expect(actualSpy.mock.calls.length).toBeGreaterThan(aBefore); // actual overlay drawn
  });

  it('dims a bar to 25% opacity when a hover chain excludes it', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-11', '2026-04-20'),
    ]);
    flushFrame();
    const internals = internalsOf(engine) as unknown as { _barsCtx: CanvasRenderingContext2D };
    // globalAlpha is a no-op setter on the recording ctx; spy the setter to
    // observe that the out-of-chain bar ('b') triggers the 0.25 dim path.
    const alphaSet = vi.fn();
    Object.defineProperty(internals._barsCtx, 'globalAlpha', { set: alphaSet, configurable: true });

    // Chain contains only 'a' — 'b' is neither the hovered id nor a pred/succ,
    // so _paintTaskAt dims it via globalAlpha = 0.25.
    engine.setHoverChain({
      hoveredId: 'a',
      predecessors: new Set<string>(),
      successors: new Set<string>(),
    });
    flushFrame();

    expect(alphaSet).toHaveBeenCalledWith(0.25);
  });

  it('setHoverChain with the same reference is a no-op (no repaint re-armed)', () => {
    const { engine, flushFrame, hasScheduledFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    flushFrame();
    const chain = {
      hoveredId: 'a',
      predecessors: new Set<string>(),
      successors: new Set<string>(),
    };
    engine.setHoverChain(chain);
    flushFrame();
    expect(hasScheduledFrame()).toBe(false); // settled

    // Same object identity → reference-equality guard short-circuits, so no new
    // bars-repaint frame is scheduled.
    engine.setHoverChain(chain);
    expect(hasScheduledFrame()).toBe(false);
  });

  it('keeps the cached hover-row valid across a setTasks reorder while a chain is live', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-11', '2026-04-20'),
    ]);
    engine.setHoverChain({
      hoveredId: 'b',
      predecessors: new Set<string>(),
      successors: new Set<string>(),
    });
    // Reorder so 'b' moves from row 1 to row 0 — setTasks re-resolves the cached
    // hover-row index via findIndex against the hovered id (must not throw / NaN).
    expect(() =>
      engine.setTasks([
        makeTask('b', '2026-04-11', '2026-04-20'),
        makeTask('a', '2026-04-01', '2026-04-10'),
      ]),
    ).not.toThrow();
    expect(() => flushFrame()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Single-row repaint path (_paintRow via _dirtyRows). Nothing populates
// _dirtyRows in normal operation (updateTask routes through the bars-only flag
// now), but the branch is kept as a general row-local invalidation path — this
// exercises it directly through the documented internal mechanism.
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — single-row repaint path (_dirtyRows)', () => {
  it('repaints exactly the dirty row and clears the set', () => {
    const { engine, flushFrame } = setup();
    engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-11', '2026-04-20'),
    ]);
    flushFrame(); // settle — nothing pending
    const internals = engine as unknown as {
      _dirtyRows: Set<number>;
      _requestRepaint: () => void;
    };

    internals._dirtyRows.add(1);
    internals._requestRepaint();
    expect(() => flushFrame()).not.toThrow();

    // The tick drained the single-row path and cleared the set.
    expect(internals._dirtyRows.size).toBe(0);
  });

  it('promotes a dirty-row repaint to a full repaint when the name gutter is on', () => {
    const { engine, flushFrame, hasScheduledFrame } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    engine.setChartOptions({
      taskNamePlacement: 'next',
      showProgressPills: true,
      showNameGutter: true,
    });
    flushFrame(); // full repaint from setChartOptions settles
    const internals = engine as unknown as {
      _dirtyRows: Set<number>;
      _fullRepaintPending: boolean;
      _requestRepaint: () => void;
    };

    internals._dirtyRows.add(0);
    internals._requestRepaint();
    flushFrame();

    // A row-local repaint would draw the bar over its frozen gutter cell, so
    // _paintRow promotes to a full repaint instead — which re-arms the loop.
    expect(internals._fullRepaintPending).toBe(true);
    expect(hasScheduledFrame()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cursor precedence (_updateCursor) + remaining guards on the input handlers.
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — hover cursor precedence over hit zones', () => {
  it('shows col-resize over a resize handle and crosshair over a link dot', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    const { aRight } = barGeom(engine);

    // Hover (no button held) over the right resize handle → col-resize.
    internals._onPointerMove(ptr({ clientX: aRight - 4, clientY: 40 }));
    expect(internals._ixCanvas.style.cursor).toBe('col-resize');

    // Hover over the link dot just past the bar's right edge → crosshair.
    internals._onPointerMove(ptr({ clientX: aRight + 12, clientY: 40 }));
    expect(internals._ixCanvas.style.cursor).toBe('crosshair');
  });

  it('emits a cancelled resize-task-end when a live resize is cancelled', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    stubPointerCapture(internals);
    const { aRight } = barGeom(engine);

    const onResizeEnd = vi.fn();
    engine.on('resize-task-end', onResizeEnd);

    internals._onPointerDown(ptr({ clientX: aRight - 4, clientY: 40 })); // resize handle
    internals._onPointerMove(ptr({ clientX: aRight + 40, clientY: 40 })); // → RESIZING
    engine.cancelDrag();

    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd.mock.calls[0][0]).toMatchObject({ id: 'a', cancelled: true });
  });

  it('arms pan on Space when the keydown target is not an editable element (null target)', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    internals._onPointerEnter();

    // target null → _isEditableTarget short-circuits false (not an HTMLElement),
    // so the Space arm proceeds.
    internals._onKeyDown({
      code: 'Space',
      key: ' ',
      repeat: false,
      target: null,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(internals._ixCanvas.style.cursor).toBe('grab');
  });

  it('onKeyUp ignores non-Space keys (pan stays armed)', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const internals = internalsOf(engine);
    internals._onPointerEnter();
    internals._onKeyDown({
      code: 'Space',
      key: ' ',
      repeat: false,
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(internals._ixCanvas.style.cursor).toBe('grab');

    // A non-Space keyup must NOT disarm the pan.
    internals._onKeyUp({ code: 'KeyA', key: 'a' } as unknown as KeyboardEvent);
    expect(internals._ixCanvas.style.cursor).toBe('grab');
  });

  it('pointerdown before scales/hit-index exist is a safe no-op', () => {
    const { engine } = setup();
    const internals = internalsOf(engine);
    stubPointerCapture(internals);
    const onStart = vi.fn();
    engine.on('drag-task', onStart);
    // No setTasks → _hitIndex/_scales null → early return.
    expect(() => internals._onPointerDown(ptr({ clientX: 100, clientY: 40 }))).not.toThrow();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('ctrl+wheel before scales exist preventDefaults but does not zoom', () => {
    const { engine } = setup();
    const internals = internalsOf(engine);
    const preventDefault = vi.fn();
    // ctrlKey passes the modifier gate but there are no scales yet → early return.
    internals._onWheel({
      ctrlKey: true,
      metaKey: false,
      deltaY: -100,
      clientX: 200,
      preventDefault,
    } as unknown as WheelEvent);
    expect(preventDefault).toHaveBeenCalled();
    expect(engine.pxPerDay).toBeNull(); // no coordinate system → no zoom applied
  });
});
