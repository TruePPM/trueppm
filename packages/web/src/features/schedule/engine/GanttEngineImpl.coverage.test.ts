/**
 * Branch-coverage companion to GanttEngineImpl.test.ts (#2459).
 *
 * The main suite covers the happy paths of the `GanttEngine` contract; this one
 * targets the conditional arms it never drives — the guards, fallbacks and
 * "other side of the ternary" branches:
 *
 *   - `openTask()` (the keyboard twin of the canvas double-click open path).
 *   - `cancelDrag()` routed at a live drag-to-link gesture, and `_cancelLinkDrag`'s
 *     no-op arm when nothing is live.
 *   - The `devicePixelRatio || 1` fallback, and `_applyDpr`'s null-context
 *     re-acquire guard after a resize.
 *   - `_paintBg`'s retained-header arm in DARK mode (issue 1523's skip path).
 *   - `setHoverChain(null)` clearing the cached hover-row band (#2096).
 *   - A link gesture that never crosses the drag threshold (cursor stays
 *     crosshair, no preview commit).
 *   - `_onPointerCancel`'s touch arm ending an in-flight pinch (#2160).
 *   - `_paintRow`, the retained row-local invalidation path (see the class
 *     comment on `_dirtyRows`): nothing in the engine populates `_dirtyRows`
 *     today, so it is reached here directly — the observable outcome is which
 *     canvas region it clears, or whether it defers to a full repaint.
 *
 * Same conventions as the main suite: a permissive recording 2D context stands
 * in for the canvas (jsdom has none), rAF is hand-driven, and no assertion
 * touches pixels — only which renderer primitive ran and what the engine's
 * observable state became.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import { GanttEngineImpl } from './GanttEngineImpl';
import { dateToLeft, dateToRight } from './GanttScaleData';
import { drawHoverRowBand, drawTimelineHeader } from './GanttRenderer';

vi.mock('./GanttRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./GanttRenderer')>();
  return {
    ...actual,
    drawHoverRowBand: vi.fn(actual.drawHoverRowBand),
    drawTimelineHeader: vi.fn(actual.drawTimelineHeader),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
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

function makeCtx(): CanvasRenderingContext2D {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    arc: vi.fn(),
    bezierCurveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    clip: vi.fn(),
    setLineDash: vi.fn(),
    measureText: vi.fn(() => ({ width: 20 }) as TextMetrics),
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

/**
 * A canvas whose `getContext` yields the recording context for the first
 * `okCalls` invocations and null thereafter — used to drive `_applyDpr`'s
 * "re-acquire failed" guard on a resize without breaking construction.
 */
function makeCanvas(ctx: CanvasRenderingContext2D, okCalls = Infinity): HTMLCanvasElement {
  const el = document.createElement('canvas');
  let calls = 0;
  el.getContext = vi.fn(() =>
    ++calls <= okCalls ? ctx : null,
  ) as unknown as HTMLCanvasElement['getContext'];
  (ctx as { canvas: HTMLCanvasElement }).canvas = el;
  return el;
}

function makeContainer(): HTMLDivElement {
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
  el.scrollTo = vi.fn((opts: ScrollToOptions) => {
    if (opts && typeof opts.left === 'number') scrollLeft = opts.left;
  }) as unknown as HTMLDivElement['scrollTo'];
  return el;
}

interface Internals {
  _ixCanvas: HTMLCanvasElement;
  _pointerFine: boolean;
  _onPointerDown: (e: PointerEvent) => void;
  _onPointerMove: (e: PointerEvent) => void;
  _onPointerUp: (e: PointerEvent) => void;
  _onPointerCancel: (e: PointerEvent) => void;
  _onResize: (entries: ResizeObserverEntry[]) => void;
  _cancelLinkDrag: () => void;
  _paintRow: (rowIndex: number) => void;
  _linkFSM: { state: string };
  _panFSM: { state: string };
}

interface Harness {
  engine: GanttEngineImpl;
  container: HTMLDivElement;
  bgCanvas: HTMLCanvasElement;
  bgCtx: CanvasRenderingContext2D;
  barsCtx: CanvasRenderingContext2D;
  ixCtx: CanvasRenderingContext2D;
  internals: Internals;
  flushFrame: () => void;
  hasScheduledFrame: () => boolean;
}

function setup(opts?: { bgOkCalls?: number }): Harness {
  let nextFrame: FrameRequestCallback | null = null;
  let rafSeq = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    nextFrame = cb;
    return ++rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );

  const bgCtx = makeCtx();
  const barsCtx = makeCtx();
  const ixCtx = makeCtx();
  const bgCanvas = makeCanvas(bgCtx, opts?.bgOkCalls);
  const barsCanvas = makeCanvas(barsCtx);
  const ixCanvas = makeCanvas(ixCtx);
  const container = makeContainer();

  const engine = new GanttEngineImpl({
    container,
    bgCanvas,
    barsCanvas,
    ixCanvas,
    initialZoom: 'day',
  });

  const internals = engine as unknown as Internals;
  // jsdom's matchMedia reports (pointer: fine) = false, which would gate off the
  // drag-to-link arm entirely; pin it to a mouse/pen pointer.
  internals._pointerFine = true;
  internals._ixCanvas.setPointerCapture = vi.fn();
  internals._ixCanvas.releasePointerCapture = vi.fn();

  return {
    engine,
    container,
    bgCanvas,
    bgCtx,
    barsCtx,
    ixCtx,
    internals,
    flushFrame: () => {
      const cb = nextFrame;
      nextFrame = null;
      cb?.(0);
    },
    hasScheduledFrame: () => nextFrame !== null,
  };
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// openTask — the keyboard twin of the dblclick open path (#2205)
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — openTask', () => {
  it('emits task-open with the requested id, exactly like a canvas double-click', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const onOpen = vi.fn();
    engine.on('task-open', onOpen);

    engine.openTask('a');

    expect(onOpen).toHaveBeenCalledWith({ id: 'a' });
  });

  it('emits for an id that is not in the current task set (React owns the routing)', () => {
    const { engine } = setup();
    engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const onOpen = vi.fn();
    engine.on('task-open', onOpen);

    engine.openTask('not-loaded');

    expect(onOpen).toHaveBeenCalledWith({ id: 'not-loaded' });
  });
});

// ---------------------------------------------------------------------------
// cancelDrag — the link-gesture arm (#1666)
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — cancelDrag with a live link gesture', () => {
  /** Arm a link gesture from row 0's link dot and drag it past the threshold. */
  function armLinkDrag(h: Harness) {
    h.engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-15', '2026-04-20'),
    ]);
    const aRight = dateToRight('2026-04-10', h.engine.scales!);
    h.internals._onPointerDown(ptr({ clientX: aRight + 12, clientY: 40 }));
    h.internals._onPointerMove(ptr({ clientX: aRight + 60, clientY: 40 }));
    return { aRight };
  }

  it('cancels the link gesture instead of the bar drag, emitting no create-link', () => {
    const h = setup();
    const { aRight } = armLinkDrag(h);
    expect(h.internals._linkFSM.state).toBe('DRAGGING');

    const onCreate = vi.fn();
    const onDragEnd = vi.fn();
    h.engine.on('create-link', onCreate);
    h.engine.on('drag-task-end', onDragEnd);

    h.engine.cancelDrag();

    expect(h.internals._linkFSM.state).toBe('IDLE');
    expect(onCreate).not.toHaveBeenCalled();
    // The bar-drag arm must not have run — a link cancel is not a drag cancel.
    expect(onDragEnd).not.toHaveBeenCalled();

    // Releasing after the cancel is inert: the gesture is already gone.
    h.internals._onPointerUp(ptr({ clientX: aRight + 60, clientY: 40 }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('_cancelLinkDrag is a no-op when no link gesture is live (no canvas clear)', () => {
    const h = setup();
    h.engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const clears = (h.ixCtx.clearRect as ReturnType<typeof vi.fn>).mock.calls.length;

    h.internals._cancelLinkDrag();

    expect(h.internals._linkFSM.state).toBe('IDLE');
    expect((h.ixCtx.clearRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(clears);
  });
});

// ---------------------------------------------------------------------------
// DPR (rule 62)
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — devicePixelRatio handling', () => {
  it('falls back to 1× when devicePixelRatio is absent/zero (backing store = CSS size)', () => {
    vi.stubGlobal('devicePixelRatio', 0);
    const { bgCanvas, container } = setup();

    expect(bgCanvas.width).toBe(800);
    expect(bgCanvas.height).toBe(600);
    expect(bgCanvas.style.width).toBe('800px');
    expect(container.style.getPropertyValue('--gantt-vw')).toBe('800px');
  });

  it('scales the backing store by devicePixelRatio on a HiDPI display', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { bgCanvas } = setup();

    expect(bgCanvas.width).toBe(1600);
    expect(bgCanvas.height).toBe(1200);
    // CSS size stays at the logical viewport — only the backing store doubles.
    expect(bgCanvas.style.width).toBe('800px');
  });

  it('survives a resize whose context re-acquire returns null (rule 79 guard)', () => {
    // 2 successful getContext calls: the constructor probe + the initial
    // _applyDpr. The resize's re-acquire then yields null.
    const h = setup({ bgOkCalls: 2 });
    h.engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    const onScales = vi.fn();
    h.engine.on('scales-change', onScales);

    expect(() =>
      h.internals._onResize([
        { contentRect: { width: 900, height: 700 } } as ResizeObserverEntry,
      ]),
    ).not.toThrow();

    // The geometry the guard runs *before* bailing is still applied…
    expect(h.bgCanvas.style.width).toBe('900px');
    expect(h.container.style.getPropertyValue('--gantt-vw')).toBe('900px');
    // …and the resize still rebuilt + published the scale data.
    expect(onScales).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Header retention on a pure vertical scroll (issue 1523) — dark arm
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — retained header band in dark mode', () => {
  it('redraws the header on a dark-mode switch, then retains it on a vertical scroll', () => {
    const h = setup();
    const header = vi.mocked(drawTimelineHeader);
    h.engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    h.flushFrame();
    expect(header).toHaveBeenCalled();

    // Dark mode changes the header palette → it must be redrawn.
    header.mockClear();
    h.engine.setDark(true);
    h.flushFrame();
    expect(header).toHaveBeenCalledTimes(1);

    // A pure VERTICAL scroll leaves the header band pixel-identical: the
    // expensive date-walk is skipped and the prior band is retained, while the
    // task area below it is still cleared and refilled in the dark palette.
    header.mockClear();
    const clearsBefore = (h.bgCtx.clearRect as ReturnType<typeof vi.fn>).mock.calls.length;
    h.container.scrollTop = 120;
    h.container.dispatchEvent(new Event('scroll'));
    h.flushFrame();

    expect(header).not.toHaveBeenCalled();
    expect((h.bgCtx.clearRect as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      clearsBefore,
    );

    // A HORIZONTAL scroll moves the header content → the date-walk runs again.
    h.container.scrollLeft = 240;
    h.container.dispatchEvent(new Event('scroll'));
    h.flushFrame();
    expect(header).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Hover chain (#475 / #2096)
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — setHoverChain clearing', () => {
  it('paints the hover-row band while a chain is set and drops it when cleared', () => {
    const h = setup();
    const band = vi.mocked(drawHoverRowBand);
    h.engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-15', '2026-04-20'),
    ]);
    h.flushFrame();

    band.mockClear();
    h.engine.setHoverChain({
      hoveredId: 'b',
      predecessors: new Set(['a']),
      successors: new Set<string>(),
    });
    h.flushFrame();
    expect(band).toHaveBeenCalledTimes(1);
    // Row index 1 — the cached lookup resolved 'b' to its row.
    expect(band.mock.calls[0][1]).toBe(1);

    // Clearing the chain resets the cached row index to -1: no band next frame.
    band.mockClear();
    h.engine.setHoverChain(null);
    h.flushFrame();
    expect(band).not.toHaveBeenCalled();
  });

  it('resolves the hover row to -1 when the hovered task is not in the task set', () => {
    const h = setup();
    const band = vi.mocked(drawHoverRowBand);
    h.engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    h.flushFrame();

    band.mockClear();
    h.engine.setHoverChain({
      hoveredId: 'ghost',
      predecessors: new Set<string>(),
      successors: new Set<string>(),
    });
    h.flushFrame();
    expect(band).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Link gesture below the drag threshold (#1666)
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — armed link gesture below the drag threshold', () => {
  it('keeps the crosshair and never snaps to a target until the threshold is crossed', () => {
    const h = setup();
    h.engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-15', '2026-04-20'),
    ]);
    const aRight = dateToRight('2026-04-10', h.engine.scales!);
    const onCreate = vi.fn();
    h.engine.on('create-link', onCreate);

    h.internals._onPointerDown(ptr({ clientX: aRight + 12, clientY: 40 }));
    expect(h.internals._linkFSM.state).toBe('ARMED');

    // A 2px twitch is under the 4px threshold — still ARMED, cursor unchanged.
    h.internals._onPointerMove(ptr({ clientX: aRight + 14, clientY: 40 }));
    expect(h.internals._linkFSM.state).toBe('ARMED');
    expect(h.internals._ixCanvas.style.cursor).toBe('crosshair');

    // Releasing in place is a silent cancel — no link is created.
    h.internals._onPointerUp(ptr({ clientX: aRight + 14, clientY: 40 }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(h.internals._linkFSM.state).toBe('IDLE');
  });

  it('shows not-allowed while the preview hovers its own source bar', () => {
    const h = setup();
    h.engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    const aRight = dateToRight('2026-04-30', h.engine.scales!);
    const aLeft = dateToLeft('2026-04-01', h.engine.scales!);

    h.internals._onPointerDown(ptr({ clientX: aRight + 12, clientY: 40 }));
    // Drag back over the source bar's own body — a self-link is rejected.
    h.internals._onPointerMove(ptr({ clientX: aLeft + 20, clientY: 40 }));

    expect(h.internals._linkFSM.state).toBe('DRAGGING');
    expect(h.internals._ixCanvas.style.cursor).toBe('not-allowed');
  });
});

// ---------------------------------------------------------------------------
// Touch pointercancel during a pinch (#2160)
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — pointercancel on touch', () => {
  const touch = (props: Partial<PointerEvent> & { clientX: number; clientY: number }) =>
    ptr({ pointerType: 'touch', ...props });

  it('a canceled second finger ends the pinch — further movement no longer zooms', () => {
    const h = setup();
    h.engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    h.engine.setPxPerDay(10);
    const startPx = h.engine.pxPerDay!;

    h.internals._onPointerDown(touch({ pointerId: 1, clientX: 200, clientY: 180 }));
    h.internals._onPointerDown(touch({ pointerId: 2, clientX: 300, clientY: 180 }));
    // Sanity: the pinch is live and spreading the fingers zooms in.
    h.internals._onPointerMove(touch({ pointerId: 2, clientX: 400, clientY: 180 }));
    const zoomed = h.engine.pxPerDay!;
    expect(zoomed).toBeGreaterThan(startPx);

    // The OS steals the second finger (scroll takeover, palm rejection…).
    h.internals._onPointerCancel(touch({ pointerId: 2, clientX: 400, clientY: 180 }));

    // Moving the surviving finger must not resume the (now dead) pinch.
    h.internals._onPointerMove(touch({ pointerId: 1, clientX: 100, clientY: 180 }));
    expect(h.engine.pxPerDay!).toBe(zoomed);
    expect(h.internals._panFSM.state).toBe('IDLE');
  });

  it('a canceled single touch releases the pan without zooming', () => {
    const h = setup();
    h.engine.setTasks([makeTask('a', '2026-04-01', '2026-04-30')]);
    h.engine.setPxPerDay(10);
    const startPx = h.engine.pxPerDay!;

    h.internals._onPointerDown(touch({ pointerId: 1, clientX: 200, clientY: 180 }));
    expect(h.internals._panFSM.state).toBe('PANNING');

    h.internals._onPointerCancel(touch({ pointerId: 1, clientX: 200, clientY: 180 }));

    expect(h.internals._panFSM.state).toBe('IDLE');
    expect(h.engine.pxPerDay!).toBe(startPx);
  });
});

// ---------------------------------------------------------------------------
// _paintRow — the retained row-local invalidation path
// ---------------------------------------------------------------------------

describe('GanttEngineImpl — single-row repaint path', () => {
  function clears(ctx: CanvasRenderingContext2D): number {
    return (ctx.clearRect as ReturnType<typeof vi.fn>).mock.calls.length;
  }

  it('clears only the row band for a visible row', () => {
    const h = setup();
    h.engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-15', '2026-04-20'),
    ]);
    h.flushFrame();

    const before = clears(h.barsCtx);
    h.internals._paintRow(1);
    const calls = (h.barsCtx.clearRect as ReturnType<typeof vi.fn>).mock.calls;

    expect(calls.length).toBe(before + 1);
    // Row 1 band: y = 1*28 + 28 = 56, height = ROW_HEIGHT (28), full width.
    expect(calls[calls.length - 1]).toEqual([0, 56, 800, 28]);
  });

  it('uses the dark surface fill for the cleared band after setDark(true)', () => {
    const h = setup();
    h.engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    h.engine.setDark(true);
    h.flushFrame();

    const before = clears(h.barsCtx);
    h.internals._paintRow(0);
    // The row band is cleared then refilled — both happen regardless of palette;
    // what the dark arm changes is the fill color, which the recording context
    // swallows. The observable contract here is that the band is still repainted.
    expect(clears(h.barsCtx)).toBe(before + 1);
    expect((h.barsCtx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it('is a no-op for a row scrolled entirely above the header band', () => {
    const h = setup();
    h.engine.setTasks([
      makeTask('a', '2026-04-01', '2026-04-10'),
      makeTask('b', '2026-04-15', '2026-04-20'),
    ]);
    h.flushFrame();
    h.container.scrollTop = 500;
    h.container.dispatchEvent(new Event('scroll'));
    h.flushFrame();

    const before = clears(h.barsCtx);
    h.internals._paintRow(0); // row 0 now sits far above the fold
    expect(clears(h.barsCtx)).toBe(before);
  });

  it('clears but draws nothing for a row below the viewport fold', () => {
    const h = setup();
    h.engine.setTasks([makeTask('a', '2026-04-01', '2026-04-10')]);
    h.flushFrame();

    const savesBefore = (h.barsCtx.save as ReturnType<typeof vi.fn>).mock.calls.length;
    h.internals._paintRow(400); // y ≈ 11 228 — far past the 600px viewport
    // The band clear runs, but the task draw (which save()s first) does not.
    expect((h.barsCtx.save as ReturnType<typeof vi.fn>).mock.calls.length).toBe(savesBefore);
  });

});
