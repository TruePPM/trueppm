import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedSearchValue } from './useDebouncedSearchValue';

describe('useDebouncedSearchValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates the local value immediately but debounces the onChange commit', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDebouncedSearchValue('', onChange, 200));

    act(() => result.current.emit('abc'));
    expect(result.current.local).toBe('abc');
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('abc');
  });

  it('resets the debounce timer on rapid typing — only the last value commits', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDebouncedSearchValue('', onChange, 200));

    act(() => result.current.emit('a'));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => result.current.emit('ab'));
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('ab');
  });

  it('clears immediately, with no debounce', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDebouncedSearchValue('', onChange, 200));

    act(() => result.current.emit('abc'));
    act(() => result.current.clear());
    expect(result.current.local).toBe('');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('');
  });

  it('reports hasQuery false for empty/whitespace-only input', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedSearchValue(value, vi.fn(), 200),
      { initialProps: { value: '' } },
    );
    expect(result.current.hasQuery).toBe(false);

    act(() => result.current.emit('  '));
    expect(result.current.hasQuery).toBe(false);

    act(() => result.current.emit('x'));
    expect(result.current.hasQuery).toBe(true);
    rerender({ value: '' });
  });

  it('re-syncs the local value when the committed value changes from outside', () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedSearchValue(value, onChange, 200),
      { initialProps: { value: 'abc' } },
    );

    act(() => result.current.emit('typed'));
    expect(result.current.local).toBe('typed');

    // e.g. a "Clear filters" action elsewhere resets the canonical value.
    rerender({ value: '' });
    expect(result.current.local).toBe('');
  });
});
