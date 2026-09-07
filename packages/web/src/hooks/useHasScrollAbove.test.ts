/**
 * useHasScrollAbove unit tests (#3473).
 *
 * Covers the vertical top-overflow probe that drives the rail's top edge-fade
 * cue: the at-origin / scrolled-away states, re-measure on scroll and on
 * ResizeObserver fire, the null (unmounted) case, and cleanup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHasScrollAbove } from './useHasScrollAbove';

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

describe('useHasScrollAbove', () => {
  it('is false at the scroll origin', () => {
    const el = makeEl({ scrollTop: 0, clientHeight: 100, scrollHeight: 500 });
    const { result } = renderHook(() => useHasScrollAbove(el));
    expect(result.current).toBe(false);
  });

  it('is true once the container is scrolled away from the top', () => {
    const el = makeEl({ scrollTop: 0, clientHeight: 100, scrollHeight: 500 });
    const { result } = renderHook(() => useHasScrollAbove(el));
    expect(result.current).toBe(false);

    act(() => {
      (el as unknown as Metrics).scrollTop = 240;
      scrollHandler?.();
    });
    expect(result.current).toBe(true);
  });

  it('tolerates 1px of sub-pixel slack at the exact top', () => {
    const el = makeEl({ scrollTop: 1, clientHeight: 100, scrollHeight: 500 });
    const { result } = renderHook(() => useHasScrollAbove(el));
    expect(result.current).toBe(false);
  });

  it('re-measures when the ResizeObserver fires (content shrank back to the top)', () => {
    const el = makeEl({ scrollTop: 240, clientHeight: 100, scrollHeight: 500 });
    const { result } = renderHook(() => useHasScrollAbove(el));
    expect(result.current).toBe(true);

    act(() => {
      // The personal tier collapsed, the browser clamped scrollTop back to 0.
      (el as unknown as Metrics).scrollTop = 0;
      roCallback?.();
    });
    expect(result.current).toBe(false);
  });

  it('is false when the ref is unmounted (null)', () => {
    const { result } = renderHook(() => useHasScrollAbove(null));
    expect(result.current).toBe(false);
  });

  it('removes the scroll listener on unmount', () => {
    const el = makeEl({ scrollTop: 0, clientHeight: 100, scrollHeight: 500 });
    const { unmount } = renderHook(() => useHasScrollAbove(el));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('measures when the container mounts AFTER first commit', () => {
    // The rail's Tier-2 scroller arrives a commit late on a cold load; a
    // `RefObject` signature would make that unobservable (the #2365 lesson).
    const el = makeEl({ scrollTop: 300, clientHeight: 100, scrollHeight: 500 });
    const { result, rerender } = renderHook(
      ({ node }: { node: HTMLElement | null }) => useHasScrollAbove(node),
      { initialProps: { node: null as HTMLElement | null } },
    );

    expect(result.current).toBe(false);

    rerender({ node: el });
    expect(result.current).toBe(true);
  });
});
