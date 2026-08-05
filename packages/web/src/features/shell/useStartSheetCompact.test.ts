import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStartSheetCompact } from './useStartSheetCompact';

interface MockMediaQueryList {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  changeListeners: Array<() => void>;
}

function setupMatchMedia(matches: boolean) {
  const mq: MockMediaQueryList = {
    matches,
    changeListeners: [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  mq.addEventListener.mockImplementation((_evt: string, cb: () => void) => {
    mq.changeListeners.push(cb);
  });
  mq.removeEventListener.mockImplementation((_evt: string, cb: () => void) => {
    mq.changeListeners = mq.changeListeners.filter((l) => l !== cb);
  });
  vi.stubGlobal('matchMedia', () => mq);
  return mq;
}

describe('useStartSheetCompact (#2728)', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('is false at ≥900px (one row of three way cards)', () => {
    setupMatchMedia(false);
    const { result } = renderHook(() => useStartSheetCompact());
    expect(result.current).toBe(false);
  });

  it('is true below 900px (full-screen, ways stacked 2×2)', () => {
    setupMatchMedia(true);
    const { result } = renderHook(() => useStartSheetCompact());
    expect(result.current).toBe(true);
  });

  it('re-renders when the viewport crosses the 900px threshold', () => {
    const mq = setupMatchMedia(false);
    const { result } = renderHook(() => useStartSheetCompact());
    expect(result.current).toBe(false);

    act(() => {
      mq.matches = true;
      mq.changeListeners.forEach((cb) => cb());
    });
    expect(result.current).toBe(true);
  });
});
