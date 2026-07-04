import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGroomingFilters } from './useGroomingFilters';

describe('useGroomingFilters (issue 1044)', () => {
  it('starts empty and inactive', () => {
    const { result } = renderHook(() => useGroomingFilters());
    expect(result.current.filters).toEqual({ query: '', dorStates: [], unestimatedOnly: false });
    expect(result.current.active).toBe(false);
  });

  it('sets the query and reports active', () => {
    const { result } = renderHook(() => useGroomingFilters());
    act(() => result.current.setQuery('telemetry'));
    expect(result.current.filters.query).toBe('telemetry');
    expect(result.current.active).toBe(true);
  });

  it('toggles a DoR state on and off', () => {
    const { result } = renderHook(() => useGroomingFilters());
    act(() => result.current.toggleDor('ready'));
    expect(result.current.filters.dorStates).toEqual(['ready']);
    act(() => result.current.toggleDor('refine'));
    expect(result.current.filters.dorStates).toEqual(['ready', 'refine']);
    act(() => result.current.toggleDor('ready'));
    expect(result.current.filters.dorStates).toEqual(['refine']);
  });

  it('toggles unestimated-only and clears everything on reset', () => {
    const { result } = renderHook(() => useGroomingFilters());
    act(() => {
      result.current.setQuery('x');
      result.current.toggleDor('idea');
      result.current.setUnestimatedOnly(true);
    });
    expect(result.current.active).toBe(true);
    act(() => result.current.reset());
    expect(result.current.filters).toEqual({ query: '', dorStates: [], unestimatedOnly: false });
    expect(result.current.active).toBe(false);
  });
});
