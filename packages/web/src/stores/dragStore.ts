/**
 * Zustand slice for Gantt drag preview state (issue #19).
 *
 * Isolated from ganttStore to keep concerns separate — drag preview state
 * is transient and never persisted.
 */

import { create } from 'zustand';
import type { DragPhase, DragPreviewResult, WorstMilestone } from '../types';

export interface DragState {
  phase: DragPhase;
  draggedTaskId: string | null;
  /** Per-task CPM results from the worker. Capped at 10 (rule 32). */
  previewResults: DragPreviewResult[];
  worstMilestone: WorstMilestone | null;
  /** Count of tasks beyond the 10-bar cap (rule 32). */
  overflowCount: number;

  // Actions
  startDrag: (taskId: string) => void;
  updatePreview: (
    results: DragPreviewResult[],
    worstMilestone: WorstMilestone | null,
    overflowCount: number,
  ) => void;
  commitDrag: () => void;
  cancelDrag: () => void;
  setError: () => void;
}

export const useDragStore = create<DragState>((set) => ({
  phase: 'idle',
  draggedTaskId: null,
  previewResults: [],
  worstMilestone: null,
  overflowCount: 0,

  startDrag: (taskId) =>
    set({
      phase: 'dragging',
      draggedTaskId: taskId,
      previewResults: [],
      worstMilestone: null,
      overflowCount: 0,
    }),

  updatePreview: (results, worstMilestone, overflowCount) =>
    set({ previewResults: results, worstMilestone, overflowCount }),

  commitDrag: () =>
    set({
      phase: 'committing',
      previewResults: [],
      worstMilestone: null,
      overflowCount: 0,
    }),

  cancelDrag: () =>
    set({
      phase: 'idle',
      draggedTaskId: null,
      previewResults: [],
      worstMilestone: null,
      overflowCount: 0,
    }),

  setError: () => set({ phase: 'error' }),
}));
