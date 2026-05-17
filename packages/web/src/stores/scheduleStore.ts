import { create } from 'zustand';
import type { ZoomLevel } from '@/types';

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
  setZoomLevel: (zoom: ZoomLevel) => void;
  setSelectedTaskId: (id: string | null) => void;
  scrollToTask: (id: string | null) => void;
  setScheduleError: (msg: string | null) => void;
  setScheduleActionToast: (toast: ScheduleActionToast | null) => void;
}

export const useScheduleStore = create<GanttState>()((set) => ({
  zoomLevel: 'week',
  selectedTaskId: null,
  scrollToTaskId: null,
  scheduleError: null,
  scheduleActionToast: null,
  setZoomLevel: (zoomLevel) => set({ zoomLevel }),
  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
  scrollToTask: (scrollToTaskId) => set({ scrollToTaskId }),
  setScheduleError: (scheduleError) => set({ scheduleError }),
  setScheduleActionToast: (scheduleActionToast) => set({ scheduleActionToast }),
}));
