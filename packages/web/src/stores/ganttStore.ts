import { create } from 'zustand';
import type { ZoomLevel } from '@/types';

interface GanttState {
  zoomLevel: ZoomLevel;
  selectedTaskId: string | null;
  setZoomLevel: (zoom: ZoomLevel) => void;
  setSelectedTaskId: (id: string | null) => void;
}

export const useGanttStore = create<GanttState>()((set) => ({
  zoomLevel: 'week',
  selectedTaskId: null,
  setZoomLevel: (zoomLevel) => set({ zoomLevel }),
  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
}));
