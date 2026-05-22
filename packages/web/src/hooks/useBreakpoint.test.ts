import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBreakpoint } from './useBreakpoint';

interface MockMediaQueryList {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  changeListeners: Array<() => void>;
}

function setupMatchMedia(matches: { md: boolean; lg: boolean }) {
  const mqs = new Map<string, MockMediaQueryList>();
  function build(_q: string, m: boolean): MockMediaQueryList {
    const mq: MockMediaQueryList = {
      matches: m,
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
    return mq;
  }
  mqs.set('(min-width: 768px)', build('(min-width: 768px)', matches.md));
  mqs.set('(min-width: 1024px)', build('(min-width: 1024px)', matches.lg));
  vi.stubGlobal('matchMedia', (q: string) => {
    return mqs.get(q) ?? build(q, false);
  });
  return mqs;
}

describe('useBreakpoint', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns "lg" at ≥1024px', () => {
    setupMatchMedia({ md: true, lg: true });
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('lg');
  });

  it('returns "md" between 768 and 1023', () => {
    setupMatchMedia({ md: true, lg: false });
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('md');
  });

  it('returns "sm" below 768px', () => {
    setupMatchMedia({ md: false, lg: false });
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('sm');
  });

  it('re-renders when the viewport tier changes', () => {
    const mqs = setupMatchMedia({ md: true, lg: true });
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('lg');

    act(() => {
      const lgMq = mqs.get('(min-width: 1024px)')!;
      lgMq.matches = false;
      lgMq.changeListeners.forEach((cb) => cb());
    });
    expect(result.current).toBe('md');

    act(() => {
      const mdMq = mqs.get('(min-width: 768px)')!;
      mdMq.matches = false;
      mdMq.changeListeners.forEach((cb) => cb());
    });
    expect(result.current).toBe('sm');
  });
});
