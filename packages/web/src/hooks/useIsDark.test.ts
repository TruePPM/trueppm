import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { useThemeStore } from '@/stores/themeStore';
import { useIsDark } from './useIsDark';

// matchMedia is already stubbed in src/test/setup.ts to always return matches: false.
// Override per test when needed.
function setMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe('useIsDark', () => {
  beforeEach(() => {
    setMatchMedia(false);
    useThemeStore.setState({ theme: 'auto' });
  });

  it('returns false in light mode regardless of system preference', () => {
    setMatchMedia(true);
    useThemeStore.setState({ theme: 'light' });
    const { result } = renderHook(() => useIsDark());
    expect(result.current).toBe(false);
  });

  it('returns true in dark mode regardless of system preference', () => {
    setMatchMedia(false);
    useThemeStore.setState({ theme: 'dark' });
    const { result } = renderHook(() => useIsDark());
    expect(result.current).toBe(true);
  });

  it('returns false in auto mode when system is light', () => {
    setMatchMedia(false);
    const { result } = renderHook(() => useIsDark());
    expect(result.current).toBe(false);
  });

  it('returns true in auto mode when system is dark', () => {
    setMatchMedia(true);
    useThemeStore.setState({ theme: 'auto' });
    const { result } = renderHook(() => useIsDark());
    expect(result.current).toBe(true);
  });

  it('updates when theme switches from light to dark', () => {
    useThemeStore.setState({ theme: 'light' });
    const { result } = renderHook(() => useIsDark());
    expect(result.current).toBe(false);
    act(() => { useThemeStore.setState({ theme: 'dark' }); });
    expect(result.current).toBe(true);
  });
});
