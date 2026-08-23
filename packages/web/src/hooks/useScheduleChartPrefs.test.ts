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

  it('defaults BOTH views to hidden names, everything else visible (#2960)', () => {
    // Neither default is a free-floating on-bar label: nothing measures those
    // against the arrows and bars they overdraw (#2422). Timeline joined Grid on
    // `hidden` once it started rendering the outline that carries the names.
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs).toEqual({
      dependencyLinesVisible: true,
      taskNamePlacementByView: { grid: 'hidden', timeline: 'hidden' },
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
    act(() => result.current.setTaskNamePlacement('timeline', 'next'));
    act(() => result.current.setTaskNamePlacement('grid', 'hidden'));

    // The two views diverge — setting one does not touch the other.
    expect(result.current.prefs.taskNamePlacementByView).toEqual({
      grid: 'hidden',
      timeline: 'next',
    });
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as ScheduleChartPrefs;
    expect(stored.taskNamePlacementByView).toEqual({ grid: 'hidden', timeline: 'next' });
  });

  it('falls a persisted `left` back to the view default (#2960 retired the gutter)', () => {
    // `left` was the SHIPPED Timeline default, so most existing users carry it.
    // It must land on `hidden` — the closest behavior, since the outline now
    // renders the names in a real frozen column — never on free-floating
    // `next` labels over their bars.
    localStorage.setItem(
      KEY,
      JSON.stringify({ taskNamePlacementByView: { grid: 'next', timeline: 'left' } }),
    );
    const { result } = renderHook(() => useScheduleChartPrefs());
    expect(result.current.prefs.taskNamePlacementByView).toEqual({
      grid: 'next',
      timeline: 'hidden',
    });
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

    it('drops a legacy `left` scalar to the Timeline default (#2960 retired it)', () => {
      localStorage.setItem(KEY, JSON.stringify({ taskNamePlacement: 'left' }));
      const { result } = renderHook(() => useScheduleChartPrefs());
      expect(result.current.prefs.taskNamePlacementByView).toEqual({
        grid: 'hidden',
        timeline: 'hidden',
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
      timeline: 'hidden',
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
      timeline: 'hidden',
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
    expect(hiddenChartCountForView(base, true)).toBe(0);
    expect(hiddenChartCountForView({ ...base, sprintBandsVisible: false }, true)).toBe(1);
  });

  it('does not count a hidden sprint window on a project that has none (#2738)', () => {
    // The badge would otherwise point at the absence of a mark that could never
    // have drawn — a pure waterfall plan reading "1 hidden" for nothing.
    expect(hiddenChartCountForView({ ...base, sprintBandsVisible: false }, false)).toBe(0);
    expect(hiddenChartCountForView({ ...base, sprintBandsVisible: false })).toBe(0);
  });

  it('does not count a hidden on-bar name on EITHER surface (#2960)', () => {
    // Before #2960 a hidden Timeline name counted 1, because the canvas was the
    // Timeline's sole name carrier. The Timeline now renders the same outline
    // rows the Grid does, so both defaults must show a zero badge — which is
    // also why the function no longer takes a view at all.
    expect(hiddenChartCountForView(base)).toBe(0);
    expect(
      hiddenChartCountForView({
        ...base,
        taskNamePlacementByView: { grid: 'hidden', timeline: 'hidden' },
      }),
    ).toBe(0);
    expect(
      hiddenChartCountForView({
        ...base,
        taskNamePlacementByView: { grid: 'next', timeline: 'next' },
      }),
    ).toBe(0);
  });

  it('counts hidden dependency lines and progress pills', () => {
    const prefs = { ...base, dependencyLinesVisible: false, progressPillsVisible: false };
    expect(hiddenChartCountForView(prefs)).toBe(2);
  });
});
