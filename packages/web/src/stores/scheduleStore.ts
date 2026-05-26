import { create } from 'zustand';
import type { ZoomLevel } from '@/types';
import type { QuarterMode } from '@/features/schedule/engine';

const QUARTER_MODE_KEY = 'schedule.quarterMode';

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
  setZoomLevel: (zoom: ZoomLevel) => void;
  setSelectedTaskId: (id: string | null) => void;
  scrollToTask: (id: string | null) => void;
  setScheduleError: (msg: string | null) => void;
  setScheduleActionToast: (toast: ScheduleActionToast | null) => void;
  setQuarterMode: (mode: QuarterMode) => void;
}

export const useScheduleStore = create<GanttState>()((set) => ({
  zoomLevel: 'week',
  selectedTaskId: null,
  scrollToTaskId: null,
  scheduleError: null,
  scheduleActionToast: null,
  quarterMode: readQuarterMode(),
  setZoomLevel: (zoomLevel) => set({ zoomLevel }),
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
}));
