import { useCallback, useState } from 'react';
import type { TaskNamePlacement } from '@/features/schedule/engine';
import type { ScheduleViewMode } from '@/stores/scheduleStore';

// v1 key retained across the #2107 shape change: the on-bar task-name placement
// evolved from a single global scalar (#2097) to an independent per-view value
// (Grid vs Timeline), migrated in place — see loadPrefs. Distinct from
// columnVisibility.v1 (table layout); URL params stay reserved for shareable
// *data* filters (focus/cp/crit/ms) while these are personal presentation prefs.
const CHART_PREFS_KEY = 'trueppm.schedule.chartDisplay.v1';

// Per-view placement allow-lists. `left` renders the frozen aligned-left name
// gutter (#2096), which only exists in Timeline mode — in Grid the DOM task
// table already is the left gutter, so `left` is not offered there.
const GRID_PLACEMENTS: readonly TaskNamePlacement[] = ['next', 'hidden'];
const TIMELINE_PLACEMENTS: readonly TaskNamePlacement[] = ['next', 'left', 'hidden'];

/** On-bar task-name placement, tracked independently for each view (#2107). */
export interface TaskNamePlacementByView {
  grid: TaskNamePlacement;
  timeline: TaskNamePlacement;
}

export interface ScheduleChartPrefs {
  /** Show/hide all dependency arrows on the canvas. */
  dependencyLinesVisible: boolean;
  /**
   * Where on-bar task names render (or `hidden`), independent per view (#2107).
   * Grid defaults to `hidden` — the task table already carries every name, so
   * the on-bar label is redundant ink. Timeline defaults to `next` — the table
   * is hidden, so the canvas label is the only carrier of task identity.
   */
  taskNamePlacementByView: TaskNamePlacementByView;
  /** Show/hide the on-bar progress % pills. */
  progressPillsVisible: boolean;
}

// New-user defaults (#2107): Grid hides the redundant on-bar name; Timeline
// keeps it next to the bar. Existing users' single scalar is migrated onto both
// views (see loadPrefs), so this `hidden` Grid default is only ever seen by a
// brand-new user with no stored preference.
const DEFAULT_PLACEMENT_BY_VIEW: TaskNamePlacementByView = {
  grid: 'hidden',
  timeline: 'next',
};

const DEFAULT_PREFS: ScheduleChartPrefs = {
  dependencyLinesVisible: true,
  taskNamePlacementByView: { ...DEFAULT_PLACEMENT_BY_VIEW },
  progressPillsVisible: true,
};

function defaults(): ScheduleChartPrefs {
  return {
    ...DEFAULT_PREFS,
    taskNamePlacementByView: { ...DEFAULT_PLACEMENT_BY_VIEW },
  };
}

function coercePlacement(
  value: unknown,
  allowed: readonly TaskNamePlacement[],
  fallback: TaskNamePlacement,
): TaskNamePlacement {
  return typeof value === 'string' && allowed.includes(value as TaskNamePlacement)
    ? (value as TaskNamePlacement)
    : fallback;
}

function loadPrefs(): ScheduleChartPrefs {
  try {
    const raw = localStorage.getItem(CHART_PREFS_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Placement: prefer the per-view shape (#2107); otherwise fall back to the
    // legacy global scalar (#2097) seeded into *both* views. Either source is
    // then coerced against its view's allow-list, so a legacy `left` resolves to
    // grid `hidden` (Grid has no gutter) while keeping timeline `left`.
    const byView = parsed.taskNamePlacementByView as Partial<TaskNamePlacementByView> | undefined;
    const legacyScalar = parsed.taskNamePlacement;
    const gridSource = byView?.grid ?? legacyScalar;
    const timelineSource = byView?.timeline ?? legacyScalar;

    return {
      dependencyLinesVisible:
        typeof parsed.dependencyLinesVisible === 'boolean'
          ? parsed.dependencyLinesVisible
          : DEFAULT_PREFS.dependencyLinesVisible,
      taskNamePlacementByView: {
        grid: coercePlacement(gridSource, GRID_PLACEMENTS, DEFAULT_PLACEMENT_BY_VIEW.grid),
        timeline: coercePlacement(
          timelineSource,
          TIMELINE_PLACEMENTS,
          DEFAULT_PLACEMENT_BY_VIEW.timeline,
        ),
      },
      progressPillsVisible:
        typeof parsed.progressPillsVisible === 'boolean'
          ? parsed.progressPillsVisible
          : DEFAULT_PREFS.progressPillsVisible,
    };
  } catch {
    return defaults();
  }
}

/**
 * How many chart elements are hidden for a given view — feeds the Display badge.
 *
 * A hidden *Grid* task name is deliberately NOT counted: the task table still
 * shows every name, so nothing is lost and a brand-new Grid user (names hidden
 * by default) must not see a spurious "1 active" badge on a default view. Only a
 * hidden *Timeline* name — where the canvas is the sole name carrier — counts,
 * preserving the #2097 "don't leave the user wondering where it went" intent.
 */
export function hiddenChartCountForView(prefs: ScheduleChartPrefs, view: ScheduleViewMode): number {
  const nameHidden = view === 'timeline' && prefs.taskNamePlacementByView.timeline === 'hidden';
  return (
    (prefs.dependencyLinesVisible ? 0 : 1) +
    (nameHidden ? 1 : 0) +
    (prefs.progressPillsVisible ? 0 : 1)
  );
}

export interface UseScheduleChartPrefs {
  prefs: ScheduleChartPrefs;
  setDependencyLinesVisible: (v: boolean) => void;
  /** Set the on-bar name placement for a single view, leaving the other intact. */
  setTaskNamePlacement: (view: ScheduleViewMode, v: TaskNamePlacement) => void;
  setProgressPillsVisible: (v: boolean) => void;
}

/**
 * Persist and expose the Schedule "Chart" presentation toggles in localStorage
 * (#2097, per-view name placement #2107). Distinct from {@link useColumnWidths}
 * (table column layout): these govern what the canvas renderer paints —
 * dependency arrows, on-bar task names, and progress pills — and are pushed to
 * the engine via `setChartOptions` (names/pills) and by filtering the links
 * array (arrows). The host resolves the active view's placement before handing a
 * single scalar to the engine and the Display menu.
 */
export function useScheduleChartPrefs(): UseScheduleChartPrefs {
  const [prefs, setPrefs] = useState<ScheduleChartPrefs>(loadPrefs);

  // Functional update so rapid toggles compose off the freshest state, then
  // mirror to localStorage. Private-mode/quota failures leave in-memory state.
  const persist = useCallback((next: ScheduleChartPrefs) => {
    try {
      localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(next));
    } catch {
      // quota exceeded or private mode — silently ignore
    }
    return next;
  }, []);

  const setDependencyLinesVisible = useCallback(
    (v: boolean) => setPrefs((prev) => persist({ ...prev, dependencyLinesVisible: v })),
    [persist],
  );
  const setTaskNamePlacement = useCallback(
    (view: ScheduleViewMode, v: TaskNamePlacement) =>
      setPrefs((prev) =>
        persist({
          ...prev,
          taskNamePlacementByView: { ...prev.taskNamePlacementByView, [view]: v },
        }),
      ),
    [persist],
  );
  const setProgressPillsVisible = useCallback(
    (v: boolean) => setPrefs((prev) => persist({ ...prev, progressPillsVisible: v })),
    [persist],
  );

  return {
    prefs,
    setDependencyLinesVisible,
    setTaskNamePlacement,
    setProgressPillsVisible,
  };
}
