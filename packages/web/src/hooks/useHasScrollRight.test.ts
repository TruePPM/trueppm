/**
 * useHasScrollRight unit tests (#1972).
 *
 * Covers the horizontal right-overflow probe that drives the board's right
 * edge-fade cue: the fit / overflow / scrolled-to-right states, re-measure on
 * scroll and on ResizeObserver fire, the null (unmounted) case, and cleanup.
 * The horizontal analog of useHasScrollBelow.test.ts (#1962).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHasScrollRight } from './useHasScrollRight';

type Metrics = { scrollLeft: number; clientWidth: number; scrollWidth: number };

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

describe('useHasScrollRight', () => {
  it('is false when content fits the container', () => {
    const el = makeEl({ scrollLeft: 0, clientWidth: 100, scrollWidth: 100 });
    const { result } = renderHook(() => useHasScrollRight(el));
    expect(result.current).toBe(false);
  });

  it('is true when content overflows to the right', () => {
    const el = makeEl({ scrollLeft: 0, clientWidth: 100, scrollWidth: 500 });
    const { result } = renderHook(() => useHasScrollRight(el));
    expect(result.current).toBe(true);
  });

  it('flips to false once scrolled fully right', () => {
    const el = makeEl({ scrollLeft: 0, clientWidth: 100, scrollWidth: 500 });
    const { result } = renderHook(() => useHasScrollRight(el));
    expect(result.current).toBe(true);

    act(() => {
      (el as unknown as Metrics).scrollLeft = 400; // 400 + 100 === 500 → nothing right
      scrollHandler?.();
    });
    expect(result.current).toBe(false);
  });

  it('re-measures when the ResizeObserver fires (content grew)', () => {
    const el = makeEl({ scrollLeft: 0, clientWidth: 100, scrollWidth: 100 });
    const { result } = renderHook(() => useHasScrollRight(el));
    expect(result.current).toBe(false);

    act(() => {
      (el as unknown as Metrics).scrollWidth = 400; // a column was expanded from a stub
      roCallback?.();
    });
    expect(result.current).toBe(true);
  });

  it('tolerates 1px of sub-pixel slack at the exact right edge', () => {
    // scrollLeft + clientWidth === scrollWidth - 1 → treated as fully-right.
    const el = makeEl({ scrollLeft: 0, clientWidth: 100, scrollWidth: 101 });
    const { result } = renderHook(() => useHasScrollRight(el));
    expect(result.current).toBe(false);
  });

  it('is false when the ref is unmounted (null)', () => {
    const el = null;
    const { result } = renderHook(() => useHasScrollRight(el));
    expect(result.current).toBe(false);
  });

  it('removes the scroll listener on unmount', () => {
    const el = makeEl({ scrollLeft: 0, clientWidth: 100, scrollWidth: 500 });
    const { unmount } = renderHook(() => useHasScrollRight(el));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('measures when the container mounts AFTER first commit (#2365)', () => {
    // The board renders a loading skeleton before its scroll container exists,
    // so on a cold load the container arrives several commits late. The old
    // `RefObject` signature made this unobservable — a ref's identity never
    // changes, so the effect never re-ran and the right edge-fade cue (#1972)
    // never appeared.
    const el = makeEl({ scrollLeft: 0, clientWidth: 100, scrollWidth: 500 });
    const { result, rerender } = renderHook(({ node }: { node: HTMLElement | null }) =>
      useHasScrollRight(node),
    { initialProps: { node: null as HTMLElement | null } });

    expect(result.current).toBe(false);

    rerender({ node: el });
    expect(result.current).toBe(true);
  });
});
