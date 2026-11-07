import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useThemeStore } from '@/stores/themeStore';
import { queryClient } from '@/lib/queryClient';
import { useThemeInit } from './useThemeInit';

function mockMatchMedia(prefersDark: boolean) {
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const mq = {
    matches: prefersDark,
    addEventListener: vi.fn((_: string, fn: (e: { matches: boolean }) => void) => { listeners.push(fn); }),
    removeEventListener: vi.fn((_: string, fn: (e: { matches: boolean }) => void) => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
    // Real browsers update mq.matches before firing listeners — mirror that here.
    _trigger: (matches: boolean) => { mq.matches = matches; listeners.forEach((fn) => fn({ matches })); },
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mq));
  return mq;
}

beforeEach(() => {
  document.documentElement.classList.remove('dark');
  useThemeStore.setState({ theme: 'auto' });
  queryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: false });
  vi.unstubAllGlobals();
});

describe('useThemeInit', () => {
  it('adds .dark when theme is dark', () => {
    useThemeStore.setState({ theme: 'dark' });
    renderHook(() => useThemeInit());
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes .dark when theme is light', () => {
    document.documentElement.classList.add('dark');
    useThemeStore.setState({ theme: 'light' });
    renderHook(() => useThemeInit());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('auto: adds .dark when system prefers dark', () => {
    mockMatchMedia(true);
    useThemeStore.setState({ theme: 'auto' });
    renderHook(() => useThemeInit());
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('auto: removes .dark when system prefers light', () => {
    document.documentElement.classList.add('dark');
    mockMatchMedia(false);
    useThemeStore.setState({ theme: 'auto' });
    renderHook(() => useThemeInit());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('auto: reacts to OS theme change', () => {
    const mq = mockMatchMedia(false);
    useThemeStore.setState({ theme: 'auto' });
    renderHook(() => useThemeInit());
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    mq._trigger(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('useThemeInit demo default (#4508)', () => {
  const seedEdition = (demo: boolean) =>
    queryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: demo });

  beforeEach(() => {
    localStorage.clear();
    mockMatchMedia(true);
  });

  it('demo + nothing stored -> light, not persisted', () => {
    seedEdition(true);
    renderHook(() => useThemeInit());
    expect(useThemeStore.getState().theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('trueppm.theme')).toBeNull();
  });

  it('demo + stored dark -> dark wins', () => {
    seedEdition(true);
    localStorage.setItem('trueppm.theme', 'dark');
    useThemeStore.setState({ theme: 'dark' });
    renderHook(() => useThemeInit());
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('non-demo -> stays auto', () => {
    seedEdition(false);
    renderHook(() => useThemeInit());
    expect(useThemeStore.getState().theme).toBe('auto');
  });
});

describe('useThemeInit demo default, stored auto (#4508)', () => {
  it('demo + stored auto stays auto (an explicit choice)', () => {
    localStorage.clear();
    mockMatchMedia(true);
    queryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: true });
    localStorage.setItem('trueppm.theme', 'auto');
    useThemeStore.setState({ theme: 'auto' });
    renderHook(() => useThemeInit());
    expect(useThemeStore.getState().theme).toBe('auto');
  });
});
