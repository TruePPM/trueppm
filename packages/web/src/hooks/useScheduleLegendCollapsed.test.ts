import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { useScheduleLegendCollapsed } from './useScheduleLegendCollapsed';

const STORAGE_KEY = 'trueppm.schedule.legend.collapsed.v1';

describe('useScheduleLegendCollapsed', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to expanded (collapsed = false) on first visit', () => {
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    expect(result.current.collapsed).toBe(false);
  });

  it('toggle flips state and persists to localStorage', () => {
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('setCollapsed writes the explicit value to localStorage', () => {
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    act(() => result.current.setCollapsed(true));
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('restores collapsed state across reloads (acceptance criterion)', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    expect(result.current.collapsed).toBe(true);
  });

  it('treats any non-"true" stored value as expanded', () => {
    localStorage.setItem(STORAGE_KEY, 'garbage');
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    expect(result.current.collapsed).toBe(false);
  });

  it('responds to cross-tab storage events', () => {
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    expect(result.current.collapsed).toBe(false);
    act(() => {
      localStorage.setItem(STORAGE_KEY, 'true');
      window.dispatchEvent(
        new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'true' }),
      );
    });
    expect(result.current.collapsed).toBe(true);
  });

  it('ignores storage events for unrelated keys', () => {
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'some.other.key', newValue: 'true' }),
      );
    });
    expect(result.current.collapsed).toBe(false);
  });
});
