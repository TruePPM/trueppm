import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

// ---------------------------------------------------------------------------
// matchMedia stub helpers
// ---------------------------------------------------------------------------

type ChangeHandler = (e: { matches: boolean }) => void;

function makeMatchMedia(initialMatches: boolean) {
  let _matches = initialMatches;
  const _listeners = new Set<ChangeHandler>();

  const mq = {
    get matches() {
      return _matches;
    },
    addEventListener(_event: string, handler: ChangeHandler) {
      _listeners.add(handler);
    },
    removeEventListener(_event: string, handler: ChangeHandler) {
      _listeners.delete(handler);
    },
    /** Simulate an OS preference change. */
    simulateChange(newMatches: boolean) {
      _matches = newMatches;
      _listeners.forEach((h) => h({ matches: newMatches }));
    },
  };
  return mq;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePrefersReducedMotion', () => {
  let mq: ReturnType<typeof makeMatchMedia>;

  beforeEach(() => {
    mq = makeMatchMedia(false);
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation(() => mq),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when prefers-reduced-motion is not active', () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it('returns true when prefers-reduced-motion is active initially', () => {
    mq = makeMatchMedia(true);
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => mq));
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it('updates reactively when the OS preference changes', () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      mq.simulateChange(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      mq.simulateChange(false);
    });
    expect(result.current).toBe(false);
  });

  it('unsubscribes from the media query on unmount', () => {
    const removeSpy = vi.spyOn(mq, 'removeEventListener');
    const { unmount } = renderHook(() => usePrefersReducedMotion());
    unmount();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('returns false when matchMedia is not available (SSR)', () => {
    vi.stubGlobal('matchMedia', undefined as unknown as typeof window.matchMedia);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });
});
