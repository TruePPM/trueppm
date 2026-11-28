import { useMemo, useRef } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useCapExemptIds } from './useCapExemptIds';

/**
 * Mirrors how ScheduleView consumes the hook: the capped row list is a memo over
 * the two returned ids, so a "rebuild" is that memo running again.
 */
function useCappedRowList(active: boolean, hidden: ReadonlySet<string>) {
  const hiddenRef = useRef<ReadonlySet<string>>(hidden);
  hiddenRef.current = hidden;
  const builds = useRef(0);
  const { selectedForCap, scrollTargetForCap } = useCapExemptIds(active, hiddenRef);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useMemo(() => (builds.current += 1), [selectedForCap, scrollTargetForCap]);
  return { builds, selectedForCap, scrollTargetForCap };
}

describe('useCapExemptIds (#5106 selection guard)', () => {
  beforeEach(() => {
    act(() => {
      useScheduleStore.setState({ selectedTaskId: null, scrollToTaskId: null });
    });
  });

  it('selecting rows already on screen does not rebuild the capped row list', () => {
    const { result } = renderHook(() => useCappedRowList(true, new Set(['k11', 'k12'])));
    expect(result.current.builds.current).toBe(1);
    act(() => useScheduleStore.getState().setSelectedTaskId('k1'));
    act(() => useScheduleStore.getState().setSelectedTaskId('k2'));
    act(() => useScheduleStore.getState().setSelectedTaskId('k3'));
    expect(result.current.selectedForCap).toBeNull();
    expect(result.current.builds.current).toBe(1);
  });

  it('selecting a row the cap hides rebuilds the list with that row exempt', () => {
    const { result } = renderHook(() => useCappedRowList(true, new Set(['k11', 'k12'])));
    act(() => useScheduleStore.getState().setSelectedTaskId('k12'));
    expect(result.current.selectedForCap).toBe('k12');
    expect(result.current.builds.current).toBe(2);
  });

  it('a scroll target the cap hides is exempted too', () => {
    const { result } = renderHook(() => useCappedRowList(true, new Set(['k11'])));
    act(() => useScheduleStore.setState({ scrollToTaskId: 'k11' }));
    expect(result.current.scrollTargetForCap).toBe('k11');
    expect(result.current.builds.current).toBe(2);
  });

  it('exempts nothing while the cap is not in force', () => {
    const { result } = renderHook(() => useCappedRowList(false, new Set(['k11'])));
    act(() => useScheduleStore.getState().setSelectedTaskId('k11'));
    expect(result.current.selectedForCap).toBeNull();
    expect(result.current.builds.current).toBe(1);
  });
});
