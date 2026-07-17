import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useScheduleChartPrefs,
  hiddenChartCountForView,
  type ScheduleChartPrefs,
} from './useScheduleChartPrefs';

const KEY = 'trueppm.schedule.chartDisplay.v1';

describe('useScheduleChartPrefs (#2097, per-view placement #2107)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to Grid hidden, Timeline next-to-bar, everything else visible', () => {
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs).toEqual({
      dependencyLinesVisible: true,
      taskNamePlacementByView: { grid: 'hidden', timeline: 'next' },
      progressPillsVisible: true,
    });
  });

  it('sets each view placement independently and persists to localStorage', () => {
    const { result } = renderHook(() => useScheduleChartPrefs());
    act(() => result.current.setTaskNamePlacement('timeline', 'left'));
    act(() => result.current.setTaskNamePlacement('grid', 'next'));

    // The two views diverge — setting one does not touch the other.
    expect(result.current.prefs.taskNamePlacementByView).toEqual({
      grid: 'next',
      timeline: 'left',
    });
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as ScheduleChartPrefs;
    expect(stored.taskNamePlacementByView).toEqual({ grid: 'next', timeline: 'left' });
  });

  it('persists the global chart toggles alongside the per-view placement', () => {
    const { result } = renderHook(() => useScheduleChartPrefs());
    act(() => result.current.setDependencyLinesVisible(false));
    act(() => result.current.setProgressPillsVisible(false));

    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as ScheduleChartPrefs;
    expect(stored).toMatchObject({
      dependencyLinesVisible: false,
      progressPillsVisible: false,
    });
  });

  it('rehydrates the per-view shape from localStorage on mount', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        dependencyLinesVisible: false,
        taskNamePlacementByView: { grid: 'next', timeline: 'hidden' },
        progressPillsVisible: true,
      }),
    );
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs.dependencyLinesVisible).toBe(false);
    expect(result.current.prefs.taskNamePlacementByView).toEqual({
      grid: 'next',
      timeline: 'hidden',
    });
  });

  describe('legacy scalar migration (#2097 → #2107)', () => {
    it('seeds both views from a legacy scalar placement', () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          dependencyLinesVisible: true,
          taskNamePlacement: 'next',
          progressPillsVisible: true,
        }),
      );
      const { result } = renderHook(() => useScheduleChartPrefs());
      // An existing user who never touched the control keeps `next` in both
      // views — no surprise behavior change on upgrade.
      expect(result.current.prefs.taskNamePlacementByView).toEqual({
        grid: 'next',
        timeline: 'next',
      });
    });

    it('coerces a legacy `left` scalar to Grid `hidden` while keeping Timeline `left`', () => {
      localStorage.setItem(KEY, JSON.stringify({ taskNamePlacement: 'left' }));
      const { result } = renderHook(() => useScheduleChartPrefs());
      expect(result.current.prefs.taskNamePlacementByView).toEqual({
        grid: 'hidden',
        timeline: 'left',
      });
    });
  });

  it('coerces a stored Grid `left` (invalid for Grid) to the Grid default', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ taskNamePlacementByView: { grid: 'left', timeline: 'next' } }),
    );
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs.taskNamePlacementByView.grid).toBe('hidden');
    expect(result.current.prefs.taskNamePlacementByView.timeline).toBe('next');
  });

  it('falls back to defaults on malformed stored JSON', () => {
    localStorage.setItem(KEY, '{ not json');
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs.taskNamePlacementByView).toEqual({
      grid: 'hidden',
      timeline: 'next',
    });
  });

  it('ignores an unknown placement value in storage', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ taskNamePlacementByView: { grid: 'sideways', timeline: 'sideways' } }),
    );
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs.taskNamePlacementByView).toEqual({
      grid: 'hidden',
      timeline: 'next',
    });
  });
});

describe('hiddenChartCountForView (#2107)', () => {
  const base: ScheduleChartPrefs = {
    dependencyLinesVisible: true,
    taskNamePlacementByView: { grid: 'hidden', timeline: 'next' },
    progressPillsVisible: true,
  };

  it('does not count a hidden Grid name (the table still shows it)', () => {
    // Grid default is `hidden` — a brand-new Grid user must show a zero badge.
    expect(hiddenChartCountForView(base, 'grid')).toBe(0);
  });

  it('counts a hidden Timeline name (the canvas is the sole name carrier)', () => {
    const prefs = {
      ...base,
      taskNamePlacementByView: { grid: 'hidden' as const, timeline: 'hidden' as const },
    };
    expect(hiddenChartCountForView(prefs, 'timeline')).toBe(1);
  });

  it('does not count a Timeline `left` placement — the name is still visible', () => {
    const prefs = {
      ...base,
      taskNamePlacementByView: { grid: 'hidden' as const, timeline: 'left' as const },
    };
    expect(hiddenChartCountForView(prefs, 'timeline')).toBe(0);
  });

  it('counts hidden dependency lines and progress pills in either view', () => {
    const prefs = { ...base, dependencyLinesVisible: false, progressPillsVisible: false };
    expect(hiddenChartCountForView(prefs, 'grid')).toBe(2);
    expect(hiddenChartCountForView(prefs, 'timeline')).toBe(2);
  });
});
