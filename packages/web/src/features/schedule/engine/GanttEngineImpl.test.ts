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
import { CALENDAR_QUARTERS, ZOOM_CONFIGS } from './GanttScaleData';

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
  const barsCanvas = makeCanvas(makeCtx());
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

  return { engine, container, scrollToSpy, cancelRaf, roDisconnect, flushFrame };
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

  it('fitToProject rescales and parks the project start near the left edge', () => {
    const { engine, container } = setup({ initialZoom: 'day' });
    engine.setTasks([makeTask('a', '2026-04-01', '2026-12-31')]);
    expect(() => engine.fitToProject()).not.toThrow();
    expect(engine.pxPerDay).toBeGreaterThan(0);
    expect(container.scrollLeft).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(container.scrollLeft)).toBe(true);
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
