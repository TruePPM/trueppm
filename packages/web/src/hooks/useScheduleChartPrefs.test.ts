import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScheduleChartPrefs } from './useScheduleChartPrefs';

const KEY = 'trueppm.schedule.chartDisplay.v1';

describe('useScheduleChartPrefs (#2097)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to everything visible, next-to-bar, and a zero hidden count', () => {
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs).toEqual({
      dependencyLinesVisible: true,
      taskNamePlacement: 'next',
      progressPillsVisible: true,
    });
    expect(result.current.hiddenChartCount).toBe(0);
  });

  it('persists each toggle to localStorage', () => {
    const { result } = renderHook(() => useScheduleChartPrefs());
    act(() => result.current.setDependencyLinesVisible(false));
    act(() => result.current.setTaskNamePlacement('left'));
    act(() => result.current.setProgressPillsVisible(false));

    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    expect(stored).toMatchObject({
      dependencyLinesVisible: false,
      taskNamePlacement: 'left',
      progressPillsVisible: false,
    });
  });

  it('rehydrates from localStorage on mount', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        dependencyLinesVisible: false,
        taskNamePlacement: 'hidden',
        progressPillsVisible: true,
      }),
    );
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs.dependencyLinesVisible).toBe(false);
    expect(result.current.prefs.taskNamePlacement).toBe('hidden');
  });

  it('counts each hidden chart element in hiddenChartCount', () => {
    const { result } = renderHook(() => useScheduleChartPrefs());
    act(() => result.current.setDependencyLinesVisible(false)); // +1
    act(() => result.current.setProgressPillsVisible(false)); // +1
    expect(result.current.hiddenChartCount).toBe(2);
    // 'left' placement is still a *visible* name → does not count as hidden.
    act(() => result.current.setTaskNamePlacement('left'));
    expect(result.current.hiddenChartCount).toBe(2);
    // 'hidden' placement counts.
    act(() => result.current.setTaskNamePlacement('hidden'));
    expect(result.current.hiddenChartCount).toBe(3);
  });

  it('falls back to defaults on malformed stored JSON', () => {
    localStorage.setItem(KEY, '{ not json');
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs.taskNamePlacement).toBe('next');
  });

  it('ignores an unknown placement value in storage', () => {
    localStorage.setItem(KEY, JSON.stringify({ taskNamePlacement: 'sideways' }));
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs.taskNamePlacement).toBe('next');
  });
});
