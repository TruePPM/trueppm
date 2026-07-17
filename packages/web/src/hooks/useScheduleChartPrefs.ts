import { useCallback, useState } from 'react';
import type { TaskNamePlacement } from '@/features/schedule/engine';

// v1: chart presentation toggles (#2097). Distinct from columnVisibility.v1 —
// columns are table layout; these govern what the canvas paints. Kept in
// localStorage (not URL): URL params stay reserved for shareable *data* filters
// (focus/cp/crit/ms), while these are personal presentation preferences.
const CHART_PREFS_KEY = 'trueppm.schedule.chartDisplay.v1';

export interface ScheduleChartPrefs {
  /** Show/hide all dependency arrows on the canvas. */
  dependencyLinesVisible: boolean;
  /** Where on-bar task names render (or `hidden`). */
  taskNamePlacement: TaskNamePlacement;
  /** Show/hide the on-bar progress % pills. */
  progressPillsVisible: boolean;
}

// Everything visible / next-to-bar by default — this issue adds control, not new
// defaults (#2097).
const DEFAULT_PREFS: ScheduleChartPrefs = {
  dependencyLinesVisible: true,
  taskNamePlacement: 'next',
  progressPillsVisible: true,
};

const PLACEMENTS: readonly TaskNamePlacement[] = ['next', 'left', 'hidden'];

function loadPrefs(): ScheduleChartPrefs {
  try {
    const raw = localStorage.getItem(CHART_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<ScheduleChartPrefs>;
    return {
      dependencyLinesVisible:
        typeof parsed.dependencyLinesVisible === 'boolean'
          ? parsed.dependencyLinesVisible
          : DEFAULT_PREFS.dependencyLinesVisible,
      taskNamePlacement:
        parsed.taskNamePlacement && PLACEMENTS.includes(parsed.taskNamePlacement)
          ? parsed.taskNamePlacement
          : DEFAULT_PREFS.taskNamePlacement,
      progressPillsVisible:
        typeof parsed.progressPillsVisible === 'boolean'
          ? parsed.progressPillsVisible
          : DEFAULT_PREFS.progressPillsVisible,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export interface UseScheduleChartPrefs {
  prefs: ScheduleChartPrefs;
  setDependencyLinesVisible: (v: boolean) => void;
  setTaskNamePlacement: (v: TaskNamePlacement) => void;
  setProgressPillsVisible: (v: boolean) => void;
  /** How many chart elements are currently hidden — feeds the Display badge. */
  hiddenChartCount: number;
}

/**
 * Persist and expose the Schedule "Chart" presentation toggles in localStorage
 * (#2097). Distinct from {@link useColumnWidths} (table column layout): these
 * govern what the canvas renderer paints — dependency arrows, on-bar task
 * names, and progress pills — and are pushed to the engine via `setChartOptions`
 * (names/pills) and by filtering the links array (arrows).
 */
export function useScheduleChartPrefs(): UseScheduleChartPrefs {
  const [prefs, setPrefs] = useState<ScheduleChartPrefs>(loadPrefs);

  // Functional update so rapid toggles compose off the freshest state, then
  // mirror to localStorage. Private-mode/quota failures leave in-memory state.
  const update = useCallback((patch: Partial<ScheduleChartPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(next));
      } catch {
        // quota exceeded or private mode — silently ignore
      }
      return next;
    });
  }, []);

  const setDependencyLinesVisible = useCallback(
    (v: boolean) => update({ dependencyLinesVisible: v }),
    [update],
  );
  const setTaskNamePlacement = useCallback(
    (v: TaskNamePlacement) => update({ taskNamePlacement: v }),
    [update],
  );
  const setProgressPillsVisible = useCallback(
    (v: boolean) => update({ progressPillsVisible: v }),
    [update],
  );

  // Badge semantics (#2097): a hidden chart element counts so a user who turned
  // arrows/names/pills off isn't left wondering where they went. Column layout is
  // deliberately excluded (handled by the menu, not counted).
  const hiddenChartCount =
    (prefs.dependencyLinesVisible ? 0 : 1) +
    (prefs.taskNamePlacement === 'hidden' ? 1 : 0) +
    (prefs.progressPillsVisible ? 0 : 1);

  return {
    prefs,
    setDependencyLinesVisible,
    setTaskNamePlacement,
    setProgressPillsVisible,
    hiddenChartCount,
  };
}
