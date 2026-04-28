import { create } from 'zustand';
import type { ZoomLevel } from '@/types';

interface GanttState {
  zoomLevel: ZoomLevel;
  selectedTaskId: string | null;
  /**
   * When set, TaskListPanel scrolls the virtualizer to this task then resets
   * to null. Used by the badge popover to navigate to a task. (issue #32)
   */
  scrollToTaskId: string | null;
  setZoomLevel: (zoom: ZoomLevel) => void;
  setSelectedTaskId: (id: string | null) => void;
  scrollToTask: (id: string | null) => void;
}

export const useScheduleStore = create<GanttState>()((set) => ({
  zoomLevel: 'week',
  selectedTaskId: null,
  scrollToTaskId: null,
  setZoomLevel: (zoomLevel) => set({ zoomLevel }),
  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
  scrollToTask: (scrollToTaskId) => set({ scrollToTaskId }),
}));
