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

  it('defaults to Grid hidden, Timeline aligned-left, everything else visible', () => {
    // Neither default is a free-floating on-bar label: nothing measures those
    // against the arrows and bars they overdraw (#2422).
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs).toEqual({
      dependencyLinesVisible: true,
      taskNamePlacementByView: { grid: 'hidden', timeline: 'left' },
      progressPillsVisible: true,
      sprintBandsVisible: true,
    });
  });

  it('sprint windows default ON and persist when turned off (#2738)', () => {
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs.sprintBandsVisible).toBe(true);
    act(() => result.current.setSprintBandsVisible(false));
    expect(result.current.prefs.sprintBandsVisible).toBe(false);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as ScheduleChartPrefs;
    expect(stored.sprintBandsVisible).toBe(false);
  });

  it('falls through to ON for a pref blob written before #2738', () => {
    // The key is simply absent from every stored blob predating the band —
    // an existing user must get the band, not an opt-out they never chose.
    localStorage.setItem(
      KEY,
      JSON.stringify({ dependencyLinesVisible: false, progressPillsVisible: false }),
    );
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs.sprintBandsVisible).toBe(true);
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

  describe('legacy scalar migration (#2097 → #2107, narrowed #2422)', () => {
    it('seeds Timeline from a legacy scalar but leaves Grid on its own default', () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          dependencyLinesVisible: true,
          taskNamePlacement: 'next',
          progressPillsVisible: true,
        }),
      );
      const { result } = renderHook(() => useScheduleChartPrefs());
      // The scalar was chosen when one value governed both views. Carrying it
      // into Grid is what kept the redundant on-bar label — and its collisions —
      // alive for every account that had ever opened the Schedule, which is why
      // the defect was still reproducible long after #2107 shipped. Grid loses
      // nothing by ignoring it: the task table carries every name.
      expect(result.current.prefs.taskNamePlacementByView).toEqual({
        grid: 'hidden',
        timeline: 'next',
      });
    });

    it('keeps a legacy `left` scalar on Timeline, with Grid on its default', () => {
      localStorage.setItem(KEY, JSON.stringify({ taskNamePlacement: 'left' }));
      const { result } = renderHook(() => useScheduleChartPrefs());
      expect(result.current.prefs.taskNamePlacementByView).toEqual({
        grid: 'hidden',
        timeline: 'left',
      });
    });

    it('still honours an explicit per-view Grid choice over the default', () => {
      // Narrowing the *legacy* path must not stop a user who deliberately turned
      // on-bar names back on in Grid from keeping them.
      localStorage.setItem(
        KEY,
        JSON.stringify({ taskNamePlacementByView: { grid: 'next', timeline: 'next' } }),
      );
      const { result } = renderHook(() => useScheduleChartPrefs());
      expect(result.current.prefs.taskNamePlacementByView).toEqual({
        grid: 'next',
        timeline: 'next',
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
      timeline: 'left',
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
      timeline: 'left',
    });
  });
});

describe('hiddenChartCountForView (#2107)', () => {
  const base: ScheduleChartPrefs = {
    dependencyLinesVisible: true,
    taskNamePlacementByView: { grid: 'hidden', timeline: 'next' },
    progressPillsVisible: true,
    sprintBandsVisible: true,
  };

  it('counts hidden sprint windows on the Display badge (#2738)', () => {
    expect(hiddenChartCountForView(base, 'grid', true)).toBe(0);
    expect(hiddenChartCountForView({ ...base, sprintBandsVisible: false }, 'grid', true)).toBe(1);
  });

  it('does not count a hidden sprint window on a project that has none (#2738)', () => {
    // The badge would otherwise point at the absence of a mark that could never
    // have drawn — a pure waterfall plan reading "1 hidden" for nothing.
    expect(hiddenChartCountForView({ ...base, sprintBandsVisible: false }, 'grid', false)).toBe(0);
    expect(hiddenChartCountForView({ ...base, sprintBandsVisible: false }, 'grid')).toBe(0);
  });

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
