import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstPaintStep, useToolbarFit } from './useToolbarFit';
import { MAX_LADDER_STEP, TOOLBAR_LADDER } from './toolbarLadder';

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
