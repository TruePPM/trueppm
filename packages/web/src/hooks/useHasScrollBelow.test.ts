/**
 * useHasScrollBelow unit tests (#1962).
 *
 * Covers the vertical bottom-overflow probe that drives the board's bottom
 * edge-fade cue: the fit / overflow / scrolled-to-bottom states, re-measure on
 * scroll and on ResizeObserver fire, the null-ref (unmounted) case, and cleanup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHasScrollBelow } from './useHasScrollBelow';

type Metrics = { scrollTop: number; clientHeight: number; scrollHeight: number };

let scrollHandler: (() => void) | null = null;
let roCallback: (() => void) | null = null;
const removeSpy = vi.fn();

/** Build a mock scroll element with controllable geometry + captured listeners. */
function makeEl(m: Metrics) {
  const el = {
    ...m,
    children: [] as unknown[],
    addEventListener: (type: string, cb: () => void) => {
      if (type === 'scroll') scrollHandler = cb;
    },
    removeEventListener: removeSpy,
  };
  return el as unknown as HTMLElement;
}

beforeEach(() => {
  scrollHandler = null;
  roCallback = null;
  removeSpy.mockClear();
  // Capture the ResizeObserver callback so a resize can be simulated.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        roCallback = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useHasScrollBelow', () => {
  it('is false when content fits the container', () => {
    const ref = { current: makeEl({ scrollTop: 0, clientHeight: 100, scrollHeight: 100 }) };
    const { result } = renderHook(() => useHasScrollBelow(ref));
    expect(result.current).toBe(false);
  });

  it('is true when content overflows below the fold', () => {
    const ref = { current: makeEl({ scrollTop: 0, clientHeight: 100, scrollHeight: 500 }) };
    const { result } = renderHook(() => useHasScrollBelow(ref));
    expect(result.current).toBe(true);
  });

  it('flips to false once scrolled to the bottom', () => {
    const el = makeEl({ scrollTop: 0, clientHeight: 100, scrollHeight: 500 });
    const ref = { current: el };
    const { result } = renderHook(() => useHasScrollBelow(ref));
    expect(result.current).toBe(true);

    act(() => {
      (el as unknown as Metrics).scrollTop = 400; // 400 + 100 === 500 → nothing below
      scrollHandler?.();
    });
    expect(result.current).toBe(false);
  });

  it('re-measures when the ResizeObserver fires (content grew)', () => {
    const el = makeEl({ scrollTop: 0, clientHeight: 100, scrollHeight: 100 });
    const ref = { current: el };
    const { result } = renderHook(() => useHasScrollBelow(ref));
    expect(result.current).toBe(false);

    act(() => {
      (el as unknown as Metrics).scrollHeight = 400; // a card was added
      roCallback?.();
    });
    expect(result.current).toBe(true);
  });

  it('tolerates 1px of sub-pixel slack at the exact bottom', () => {
    // scrollTop + clientHeight === scrollHeight - 1 → treated as bottom.
    const ref = { current: makeEl({ scrollTop: 0, clientHeight: 100, scrollHeight: 101 }) };
    const { result } = renderHook(() => useHasScrollBelow(ref));
    expect(result.current).toBe(false);
  });

  it('is false when the ref is unmounted (null)', () => {
    const ref = { current: null };
    const { result } = renderHook(() => useHasScrollBelow(ref));
    expect(result.current).toBe(false);
  });

  it('removes the scroll listener on unmount', () => {
    const ref = { current: makeEl({ scrollTop: 0, clientHeight: 100, scrollHeight: 500 }) };
    const { unmount } = renderHook(() => useHasScrollBelow(ref));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
