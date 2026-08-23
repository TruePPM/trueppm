import { useCallback, useState } from 'react';
import type { TaskNamePlacement } from '@/features/schedule/engine';
import type { ScheduleViewMode } from '@/stores/scheduleStore';

// v1 key retained across the #2107 shape change: the on-bar task-name placement
// evolved from a single global scalar (#2097) to an independent per-view value
// (Grid vs Timeline), migrated in place — see loadPrefs. Distinct from
// columnVisibility.v1 (table layout); URL params stay reserved for shareable
// *data* filters (focus/cp/crit/ms) while these are personal presentation prefs.
const CHART_PREFS_KEY = 'trueppm.schedule.chartDisplay.v1';

// Per-view placement allow-lists — identical since #2960, and that is the point.
// `left` rendered the frozen aligned-left name gutter (#2096), which existed
// only because Timeline hid the DOM task table. Timeline now renders the SAME
// outline rows the Grid does, so a canvas-drawn name column would be a second
// frozen name column sitting beside the real one. The placement is retired:
// `resolvePlacement` falls a persisted `left` back to the view default, so a
// user who chose it simply lands on the outline names they now have.
const GRID_PLACEMENTS: readonly TaskNamePlacement[] = ['next', 'hidden'];
const TIMELINE_PLACEMENTS: readonly TaskNamePlacement[] = ['next', 'hidden'];

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
   * BOTH views default to `hidden` since #2960: the outline carries every name
   * on both surfaces now, so the on-bar label is redundant ink — and a
   * free-floating on-bar label has no collision avoidance against the arrows or
   * neighbours it is drawn over (#2422). The per-view split is kept because the
   * Timeline's bar track is wider, so choosing `next` there is a different
   * trade than choosing it in the Grid.
   */
  taskNamePlacementByView: TaskNamePlacementByView;
  /** Show/hide the on-bar progress % pills. */
  progressPillsVisible: boolean;
  /**
   * Show/hide the sprint-window bands drawn behind the bars (#2738).
   *
   * Default ON, and deliberately NOT a view switch: hiding the band changes
   * nothing but the band. The hybrid claim is that the gated critical path and
   * the sprint cadence are one plan, so there is no mode in which the schedule
   * becomes "the sprint view" — there is only whether the window is painted.
   * A pure waterfall project has no sprints and therefore no bands, so the
   * toggle costs it nothing whether it is on or off.
   */
  sprintBandsVisible: boolean;
}

// Defaults (#2107, revised #2422, revised again #2960): both views hide the
// on-bar name, because both now render the outline that carries it. The defaults
// exist to keep free-floating on-bar labels off the canvas, because nothing
// measures them against the arrows and bars they are drawn over — see the
// placement note on ScheduleChartPrefs.
const DEFAULT_PLACEMENT_BY_VIEW: TaskNamePlacementByView = {
  grid: 'hidden',
  timeline: 'hidden',
};

const DEFAULT_PREFS: ScheduleChartPrefs = {
  dependencyLinesVisible: true,
  taskNamePlacementByView: { ...DEFAULT_PLACEMENT_BY_VIEW },
  progressPillsVisible: true,
  sprintBandsVisible: true,
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

    // Placement: prefer the per-view shape (#2107). The legacy global scalar
    // (#2097) seeds **Timeline only** — deliberately not Grid (#2422).
    //
    // That scalar was chosen when one value governed both views, so a user who
    // had ever looked at the Timeline carried `next` into Grid and kept the
    // redundant on-bar label the per-view default was introduced to remove. It
    // is why the collisions were still reproducible in Grid on a real account
    // long after #2107 shipped: the new Grid default only ever reached users who
    // had never opened the Schedule. Grid falls through to its own default and
    // loses nothing — the task table carries every name either way.
    const byView = parsed.taskNamePlacementByView as Partial<TaskNamePlacementByView> | undefined;
    const legacyScalar = parsed.taskNamePlacement;
    const gridSource = byView?.grid;
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
      // Absent from every pref blob written before #2738 — fall through to the
      // default so an existing user gets the band rather than an invisible
      // opt-out they never chose.
      sprintBandsVisible:
        typeof parsed.sprintBandsVisible === 'boolean'
          ? parsed.sprintBandsVisible
          : DEFAULT_PREFS.sprintBandsVisible,
    };
  } catch {
    return defaults();
  }
}

/**
 * How many chart elements are hidden for a given view — feeds the Display badge.
 *
 * `hasSprintBands` is whether the project has any sprint window to draw at all;
 * see the sprint-band note in the body.
 *
 * A hidden on-bar task name is deliberately NOT counted on EITHER view. Before
 * #2960 it was counted on the Timeline, where the canvas was the sole carrier of
 * a task's name and hiding it really did remove information — the #2097 "don't
 * leave the user wondering where it went" intent. The Timeline now renders the
 * same outline rows the Grid does, so the name is on screen either way and a
 * default view would otherwise wear a spurious "1 active" badge.
 *
 * The `view` parameter went with it: nothing in the count varies by surface any
 * more, and a live-looking argument no code reads is the "write but never read"
 * class at API level. Add it back when a chart element genuinely exists on one
 * surface and not the other — not on the promise that one might.
 */
export function hiddenChartCountForView(
  prefs: ScheduleChartPrefs,
  hasSprintBands = false,
): number {
  // A hidden sprint window only counts when there IS one to hide (#2738). On a
  // pure waterfall project the badge would otherwise point at the absence of a
  // mark that would never have drawn — the same "don't leave the user wondering
  // where it went" intent, applied in reverse.
  const bandsHidden = hasSprintBands && !prefs.sprintBandsVisible;
  return (
    (prefs.dependencyLinesVisible ? 0 : 1) +
    (prefs.progressPillsVisible ? 0 : 1) +
    (bandsHidden ? 1 : 0)
  );
}

export interface UseScheduleChartPrefs {
  prefs: ScheduleChartPrefs;
  setDependencyLinesVisible: (v: boolean) => void;
  /** Set the on-bar name placement for a single view, leaving the other intact. */
  setTaskNamePlacement: (view: ScheduleViewMode, v: TaskNamePlacement) => void;
  setProgressPillsVisible: (v: boolean) => void;
  setSprintBandsVisible: (v: boolean) => void;
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
  const setSprintBandsVisible = useCallback(
    (v: boolean) => setPrefs((prev) => persist({ ...prev, sprintBandsVisible: v })),
    [persist],
  );

  return {
    prefs,
    setDependencyLinesVisible,
    setTaskNamePlacement,
    setProgressPillsVisible,
    setSprintBandsVisible,
  };
}
