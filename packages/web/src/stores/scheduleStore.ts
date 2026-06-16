import { create } from 'zustand';
import type { ZoomLevel } from '@/types';
import {
  ZOOM_CONFIGS,
  clampPxPerDay,
  deriveTier,
  type QuarterMode,
} from '@/features/schedule/engine';

const QUARTER_MODE_KEY = 'schedule.quarterMode';
const VIEW_MODE_KEY = 'schedule.viewMode';

/**
 * Schedule layout mode (issue 1221, v2 redesign epic 1163).
 *  - `grid` — the WBS task-list table sits to the left of the timeline (the
 *    default; matches the prototype's "Grid" / `detailed` mode).
 *  - `timeline` — the task list is hidden and the canvas spans full width
 *    ("Timeline" / `simple` mode). Bars stay identifiable because the renderer
 *    draws each task name inline beside its bar.
 */
export type ScheduleViewMode = 'grid' | 'timeline';

/**
 * Read the persisted quarter-tier view preference (#755). Defaults to `fiscal`
 * — the workspace fiscal anchor is the more meaningful framing for planning;
 * `calendar` is the opt-out. Guarded for SSR / private-mode where localStorage
 * may be unavailable.
 */
function readQuarterMode(): QuarterMode {
  try {
    return localStorage.getItem(QUARTER_MODE_KEY) === 'calendar' ? 'calendar' : 'fiscal';
  } catch {
    return 'fiscal';
  }
}

/**
 * Read the persisted Grid↔Timeline layout preference (issue 1221). Defaults to
 * `grid` — the WBS table is the more information-dense default and matches the
 * layout the app shipped before the toggle existed. Guarded for SSR /
 * private-mode where localStorage may be unavailable.
 */
function readViewMode(): ScheduleViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'timeline' ? 'timeline' : 'grid';
  } catch {
    return 'grid';
  }
}

/**
 * Action toast surface used by Schedule mutations that need a follow-up
 * affordance (e.g. the Sprint Undo toast after duplicating into an active
 * sprint, ADR-0066 Q2). The plain `scheduleError` field is for read-only
 * "something failed" messages; this one carries an optional button.
 */
export interface ScheduleActionToast {
  /** Visible message text. */
  message: string;
  /** Optional action button — when present, renders as a brand-primary text
   *  button to the right of the message. */
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss in ms. Defaults to 6000 (ADR-0066 ux-design spec). */
  durationMs?: number;
}

interface GanttState {
  /**
   * Continuous timeline zoom in logical px/day (#351) — the source of truth.
   * Clamped to [MIN_PX_PER_DAY, MAX_PX_PER_DAY]. `zoomLevel` is derived from it.
   */
  pxPerDay: number;
  /**
   * Discrete zoom tier DERIVED from `pxPerDay` (#351). Kept as a stored field so
   * existing consumers (CanvasScheduleTimeline header formatting, ScheduleView's
   * QuarterModeControl gate) can read it without recomputing. Always equals
   * `deriveTier(pxPerDay)`.
   */
  zoomLevel: ZoomLevel;
  selectedTaskId: string | null;
  /**
   * When set, TaskListPanel scrolls the virtualizer to this task then resets
   * to null. Used by the badge popover to navigate to a task. (issue #32)
   */
  scrollToTaskId: string | null;
  /** Transient error message shown as a toast in ScheduleView. Auto-cleared by the caller. */
  scheduleError: string | null;
  /** Action toast (Undo-style affordance) — supersedes the simple error toast
   *  for mutations that grant a follow-up action. ScheduleView renders it. */
  scheduleActionToast: ScheduleActionToast | null;
  /** Quarter/year header tier mode (#755) — `fiscal` follows the workspace
   *  fiscal-year start; `calendar` uses Jan–Mar = Q1. Persisted to localStorage. */
  quarterMode: QuarterMode;
  /** Grid↔Timeline layout mode (issue 1221) — `grid` shows the WBS table beside the
   *  timeline; `timeline` hides it for a full-width canvas. Persisted. */
  viewMode: ScheduleViewMode;
  /** Set the continuous zoom; clamps and re-derives `zoomLevel` (#351). */
  setPxPerDay: (px: number) => void;
  /**
   * Select a discrete tier (#351). Snaps `pxPerDay` to the tier's canonical
   * value so the readout and the engine stay consistent.
   */
  setZoomLevel: (zoom: ZoomLevel) => void;
  setSelectedTaskId: (id: string | null) => void;
  scrollToTask: (id: string | null) => void;
  setScheduleError: (msg: string | null) => void;
  setScheduleActionToast: (toast: ScheduleActionToast | null) => void;
  setQuarterMode: (mode: QuarterMode) => void;
  setViewMode: (mode: ScheduleViewMode) => void;
}

export const useScheduleStore = create<GanttState>()((set) => ({
  // Default to the 'week' tier's px/day so the initial derived tier is 'week'
  // (matches the pre-#351 default zoomLevel). pxPerDay is the source of truth.
  pxPerDay: ZOOM_CONFIGS.week.pxPerDay,
  zoomLevel: 'week',
  selectedTaskId: null,
  scrollToTaskId: null,
  scheduleError: null,
  scheduleActionToast: null,
  quarterMode: readQuarterMode(),
  viewMode: readViewMode(),
  setPxPerDay: (px) => {
    const pxPerDay = clampPxPerDay(px);
    set({ pxPerDay, zoomLevel: deriveTier(pxPerDay) });
  },
  setZoomLevel: (zoomLevel) =>
    set({ zoomLevel, pxPerDay: ZOOM_CONFIGS[zoomLevel].pxPerDay }),
  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
  scrollToTask: (scrollToTaskId) => set({ scrollToTaskId }),
  setScheduleError: (scheduleError) => set({ scheduleError }),
  setScheduleActionToast: (scheduleActionToast) => set({ scheduleActionToast }),
  setQuarterMode: (quarterMode) => {
    try {
      localStorage.setItem(QUARTER_MODE_KEY, quarterMode);
    } catch {
      // Private mode / SSR — the in-memory store value still drives the session.
    }
    set({ quarterMode });
  },
  setViewMode: (viewMode) => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch {
      // Private mode / SSR — the in-memory store value still drives the session.
    }
    set({ viewMode });
  },
}));
