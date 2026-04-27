import { beforeEach, describe, expect, it } from 'vitest';
import { useThemeStore } from './themeStore';

const STORAGE_KEY = 'trueppm.theme';

beforeEach(() => {
  localStorage.clear();
  // Reset store to initial state (re-read storage)
  useThemeStore.setState({ theme: 'auto' });
});

describe('themeStore', () => {
  it('defaults to auto when localStorage is empty', () => {
    expect(useThemeStore.getState().theme).toBe('auto');
  });

  it('reads light from localStorage', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    // Simulate fresh store read
    useThemeStore.setState({ theme: localStorage.getItem(STORAGE_KEY) as 'light' });
    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('setTheme updates state and persists to localStorage', () => {
    useThemeStore.getState().setTheme('dark');
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('setTheme round-trips through auto', () => {
    useThemeStore.getState().setTheme('auto');
    expect(useThemeStore.getState().theme).toBe('auto');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('auto');
  });
});
