import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstPaintStep, useToolbarFit } from './useToolbarFit';
import { DEMO_TOOLBAR_LADDER, MAX_LADDER_STEP, TOOLBAR_LADDER } from './toolbarLadder';

const measureMock = vi.hoisted(() => vi.fn<() => number>());
vi.mock('./toolbarLadder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./toolbarLadder')>();
  return { ...actual, measureToolbarContent: measureMock };
});

function bar(clientWidth: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  document.body.appendChild(el);
  return el;
}

const originalInnerWidth = window.innerWidth;
beforeEach(() => {
  measureMock.mockReset();
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true, writable: true });
});
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    value: originalInnerWidth,
    configurable: true,
    writable: true,
  });
  document.body.innerHTML = '';
});

describe('firstPaintStep', () => {
  it('seeds a roomier composition the wider the viewport', () => {
    expect(firstPaintStep(2560)).toBe(3);
    expect(firstPaintStep(1920)).toBe(3);
    expect(firstPaintStep(1440)).toBe(8);
    expect(firstPaintStep(1280)).toBe(9);
    expect(firstPaintStep(1279)).toBe(MAX_LADDER_STEP);
    expect(firstPaintStep(375)).toBe(MAX_LADDER_STEP);
  });
});

describe('useToolbarFit', () => {
  it('parks at step 0 and measures nothing when disabled', () => {
    const el = bar(500);
    const { result } = renderHook(() => useToolbarFit({ current: el }, false));
    expect(result.current.step).toBe(0);
    expect(measureMock).not.toHaveBeenCalled();
  });

  it('snaps to the roomy end when the bar is unmeasurable (jsdom / display:none)', () => {
    const el = bar(0);
    measureMock.mockReturnValue(0);
    const { result } = renderHook(() => useToolbarFit({ current: el }));
    // Seeded pessimistically from a 1000px viewport, then released.
    expect(result.current.step).toBe(0);
  });

  it('holds the seed when the ref is not attached yet', () => {
    const { result } = renderHook(() => useToolbarFit({ current: null }));
    expect(result.current.step).toBe(MAX_LADDER_STEP);
    expect(measureMock).not.toHaveBeenCalled();
  });

  it('walks down the ladder while the content overflows, then stops', () => {
    Object.defineProperty(window, 'innerWidth', {
      value: 1920,
      configurable: true,
      writable: true,
    });
    const el = bar(500);
    // Step 3 overflows; the first rung applied saves 200px, which fits.
    measureMock.mockReturnValueOnce(600).mockReturnValue(400);
    const { result } = renderHook(() => useToolbarFit({ current: el }));
    expect(result.current.step).toBe(4);
    // Fits with 100px to spare, less than the learned 200px cost + hysteresis: stays.
    expect(measureMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('climbs back a rung on remeasure once there is room for its learned cost', () => {
    Object.defineProperty(window, 'innerWidth', {
      value: 1920,
      configurable: true,
      writable: true,
    });
    const el = bar(500);
    measureMock.mockReturnValueOnce(600).mockReturnValue(400);
    const { result } = renderHook(() => useToolbarFit({ current: el }));
    expect(result.current.step).toBe(4);

    // The strings got shorter (a pin removed): 500 - 100 >= 200 + 24 undoes the
    // learned rung, and the loop keeps climbing while each earlier rung's estimate
    // also fits. A second remeasure at the same width is a fixed point.
    measureMock.mockReturnValue(100);
    act(() => result.current.remeasure());
    const settled = result.current.step;
    expect(settled).toBeLessThan(4);
    act(() => result.current.remeasure());
    expect(result.current.step).toBe(settled);
  });

  it('re-runs the loop when the inventory signature changes', () => {
    Object.defineProperty(window, 'innerWidth', {
      value: 1920,
      configurable: true,
      writable: true,
    });
    const el = bar(500);
    measureMock.mockReturnValue(400);
    const { result, rerender } = renderHook(
      ({ sig }: { sig: string }) => useToolbarFit({ current: el }, true, sig),
      { initialProps: { sig: 'a' } },
    );
    expect(result.current.step).toBe(3);
    // A pin added: the bar overflows at every rung, so the loop walks to the end.
    measureMock.mockReturnValue(600);
    rerender({ sig: 'b' });
    expect(result.current.step).toBe(MAX_LADDER_STEP);
  });

  it('stops adjusting within a pass once the cap is hit on a rung that saves nothing', () => {
    Object.defineProperty(window, 'innerWidth', {
      value: 1920,
      configurable: true,
      writable: true,
    });
    const el = bar(500);
    // Content never fits and never shrinks: the loop must not spin forever.
    measureMock.mockReturnValue(600);
    const { result } = renderHook(() => useToolbarFit({ current: el }));
    expect(result.current.step).toBeLessThanOrEqual(TOOLBAR_LADDER.length);
    expect(result.current.step).toBeGreaterThan(3);
  });
});

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
}

describe('useToolbarFit: bail-out, ladder swap, available <= 0', () => {
  it('bails out of an oscillating pass instead of spinning (MAX_ADJUSTMENTS_PER_PASS)', () => {
    setViewport(1920);
    // A rung that never changes the measured content (a stale box) while the
    // available width flips between cramped and roomy: every pass wants to move
    // and no cost is ever learned, so only the per-pass cap can end it. Without
    // the cap React throws "Maximum update depth exceeded".
    let n = 0;
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', {
      get: () => (n % 2 === 0 ? 500 : 2000),
      configurable: true,
    });
    document.body.appendChild(el);
    measureMock.mockImplementation(() => {
      n += 1;
      return 600;
    });
    const { result } = renderHook(() => useToolbarFit({ current: el }));
    expect(result.current.step).toBeGreaterThanOrEqual(0);
    expect(result.current.step).toBeLessThanOrEqual(MAX_LADDER_STEP);
    // The initial measure, then MAX_ADJUSTMENTS_PER_PASS (= MAX_LADDER_STEP + 2)
    // adjusting passes; the pass after the last one is the capped no-op.
    expect(measureMock.mock.calls.length).toBe(MAX_LADDER_STEP + 3);
  });

  it('re-learns from scratch when the ladder is swapped (demo vs normal)', () => {
    setViewport(1920);
    const el = bar(500);
    measureMock.mockReturnValueOnce(600).mockReturnValue(400);
    const { result, rerender } = renderHook(
      ({ ladder }: { ladder: typeof TOOLBAR_LADDER }) =>
        useToolbarFit({ current: el }, true, '', ladder),
      { initialProps: { ladder: TOOLBAR_LADDER } },
    );
    // Rung 3 applied and its saving (200px) learned: 60px of room is not enough to undo it.
    expect(result.current.step).toBe(4);
    measureMock.mockReset();
    measureMock.mockReturnValue(440);

    // A different ladder with cheap rungs. A stale learned 200px cost, indexed by
    // position, would pin the bar at step 4; invalidation lets it use the new estimates.
    const cheap = TOOLBAR_LADDER.map((r) => ({ ...r, estimate: 10 }));
    rerender({ ladder: cheap });
    expect(measureMock).toHaveBeenCalled();
    expect(result.current.step).toBeLessThan(4);
  });

  it('keeps a stable result across the demo ladder swap without throwing', () => {
    setViewport(1920);
    const el = bar(500);
    measureMock.mockReturnValue(400);
    const { result, rerender } = renderHook(
      ({ ladder }: { ladder: typeof TOOLBAR_LADDER }) =>
        useToolbarFit({ current: el }, true, '', ladder),
      { initialProps: { ladder: TOOLBAR_LADDER } },
    );
    const before = result.current.step;
    rerender({ ladder: DEMO_TOOLBAR_LADDER });
    expect(result.current.step).toBe(before);
  });

  it('resolves to step 0 when a previously measurable bar collapses to zero width', () => {
    setViewport(1920);
    let width = 500;
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { get: () => width, configurable: true });
    document.body.appendChild(el);
    measureMock.mockReturnValue(600);
    const { result } = renderHook(() => useToolbarFit({ current: el }));
    expect(result.current.step).toBeGreaterThan(3);
    width = 0;
    act(() => result.current.remeasure());
    expect(result.current.step).toBe(0);
  });
});

describe('useToolbarFit: ResizeObserver wiring', () => {
  type Callback = () => void;
  const observers: Array<{
    cb: Callback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const originalRO = globalThis.ResizeObserver;

  beforeEach(() => {
    observers.length = 0;
    globalThis.ResizeObserver = class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      constructor(cb: Callback) {
        observers.push({ cb, observe: this.observe, disconnect: this.disconnect });
      }
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = originalRO;
  });

  it('observes the bar and disconnects on unmount', () => {
    const el = bar(500);
    const ref = { current: el };
    measureMock.mockReturnValue(100);
    const { unmount } = renderHook(() => useToolbarFit(ref));
    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledWith(el);
    unmount();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it('does not observe when disabled', () => {
    const el = bar(500);
    const ref = { current: el };
    renderHook(() => useToolbarFit(ref, false));
    expect(observers).toHaveLength(0);
  });

  it('re-measures when the observer fires, and the fire resets the adjustment budget', () => {
    setViewport(1920);
    const el = bar(500);
    const ref = { current: el };
    measureMock.mockReturnValue(100);
    const { result } = renderHook(() => useToolbarFit(ref));
    expect(result.current.step).toBe(0);
    const callsBefore = measureMock.mock.calls.length;

    // The box shrank: the same content now overflows. Only the observer can say so.
    Object.defineProperty(el, 'clientWidth', { value: 50, configurable: true });
    measureMock.mockReturnValue(600);
    act(() => observers[0].cb());
    expect(measureMock.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(result.current.step).toBe(MAX_LADDER_STEP);

    // Widen again: observer fires, the loop climbs back.
    Object.defineProperty(el, 'clientWidth', { value: 2000, configurable: true });
    measureMock.mockReturnValue(100);
    act(() => observers[0].cb());
    expect(result.current.step).toBe(0);
  });

  it('an observer fire restores an adjustment budget the previous pass exhausted', () => {
    setViewport(1920);
    // Exhaust the per-pass budget with the oscillating bar, leaving the cap hit.
    let oscillate = true;
    let n = 0;
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', {
      get: () => (oscillate ? (n % 2 === 0 ? 500 : 2000) : 50),
      configurable: true,
    });
    document.body.appendChild(el);
    measureMock.mockImplementation(() => {
      n += 1;
      return 600;
    });
    const ref = { current: el };
    const { result } = renderHook(() => useToolbarFit(ref));
    const stuck = result.current.step;
    expect(stuck).toBeLessThan(MAX_LADDER_STEP);

    // The box is now genuinely cramped. Without the observer's budget reset the
    // spent budget swallows this pass and the bar stays clipped at `stuck`.
    oscillate = false;
    act(() => observers[0].cb());
    expect(result.current.step).toBeGreaterThan(stuck);
  });
});
