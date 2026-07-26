import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFilterAnnouncement } from './useFilterAnnouncement';

describe('useFilterAnnouncement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces nothing until the message settles', () => {
    const { result } = renderHook(() => useFilterAnnouncement('18 of 214 rows match Blocked'));
    expect(result.current).toBe('');
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBe('18 of 214 rows match Blocked');
  });

  it('collapses a burst of changes into one announcement', () => {
    // The behaviour that matters: the panel stays open across selections, so the
    // count changes on every click. A screen reader must hear the final count
    // once, not a stream of half-finished ones.
    const { result, rerender } = renderHook(({ m }) => useFilterAnnouncement(m), {
      initialProps: { m: '18 of 214' },
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    rerender({ m: '22 of 214' });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    rerender({ m: '26 of 214' });
    expect(result.current).toBe('');
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBe('26 of 214');
  });

  it('clears immediately when the filter is removed', () => {
    const { result, rerender } = renderHook(({ m }) => useFilterAnnouncement(m), {
      initialProps: { m: '18 of 214' },
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBe('18 of 214');
    rerender({ m: '' });
    // No wait: an empty live region is silent, so there is nothing to debounce.
    expect(result.current).toBe('');
  });

  it('honors a custom delay', () => {
    const { result } = renderHook(() => useFilterAnnouncement('done', 100));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('done');
  });
});
