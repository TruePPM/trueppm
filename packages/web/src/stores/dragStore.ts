/**
 * Zustand slice for Gantt drag preview state (issue #19).
 *
 * Isolated from scheduleStore to keep concerns separate — drag preview state
 * is transient and never persisted.
 *
 * Extended in issue #34 to support keyboard rescheduling (same state machine,
 * additional keyboard-mode flags).
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
  /** True when the active drag was initiated via keyboard (issue #34). */
  isKeyboardMode: boolean;
  /**
   * Cumulative working-day nudge applied during keyboard reschedule.
   * 0 when no keyboard drag is active.
   */
  keyboardDelta: number;
  /**
   * The committed start date after a keyboard or mouse drag confirm.
   * Set just before phase transitions to 'committing'; read by the PATCH
   * dispatcher in ScheduleView. Null when phase is not 'committing'.
   */
  confirmedStart: string | null;
  /** Task being named in the inline editor — ghost bar origin (issue #344). */
  buildingTaskId: string | null;
  /** Ghost bar start ISO date (today). Null outside 'building' phase. */
  buildingStart: string | null;
  /** Ghost bar finish ISO date (today + default duration). Null outside 'building' phase. */
  buildingFinish: string | null;

  // Actions
  /**
   * Begin a drag. `isKeyboard` distinguishes keyboard reschedule (issue #34)
   * from a pointer drag so the overlay can render the correct instruction strip.
   */
  startDrag: (taskId: string, isKeyboard?: boolean) => void;
  updatePreview: (
    results: DragPreviewResult[],
    worstMilestone: WorstMilestone | null,
    overflowCount: number,
  ) => void;
  commitDrag: (confirmedStart?: string) => void;
  cancelDrag: () => void;
  setError: () => void;
  setKeyboardDelta: (delta: number) => void;
  /** Enter 'building' phase: show a ghost bar while the user names a new task (#344). */
  startBuilding: (taskId: string, ghostStart: string, ghostFinish: string) => void;
  /** Leave 'building' phase (name committed or cancelled). */
  stopBuilding: () => void;
}

export const useDragStore = create<DragState>((set) => ({
  phase: 'idle',
  draggedTaskId: null,
  previewResults: [],
  worstMilestone: null,
  overflowCount: 0,
  isKeyboardMode: false,
  keyboardDelta: 0,
  confirmedStart: null,
  buildingTaskId: null,
  buildingStart: null,
  buildingFinish: null,

  startDrag: (taskId, isKeyboard = false) =>
    set({
      phase: 'dragging',
      draggedTaskId: taskId,
      previewResults: [],
      worstMilestone: null,
      overflowCount: 0,
      isKeyboardMode: isKeyboard,
      keyboardDelta: 0,
      confirmedStart: null,
    }),

  updatePreview: (results, worstMilestone, overflowCount) =>
    set({ previewResults: results, worstMilestone, overflowCount }),

  commitDrag: (confirmedStart) =>
    set({
      phase: 'committing',
      confirmedStart: confirmedStart ?? null,
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
      isKeyboardMode: false,
      keyboardDelta: 0,
      confirmedStart: null,
      buildingTaskId: null,
      buildingStart: null,
      buildingFinish: null,
    }),

  setError: () => set({ phase: 'error' }),

  setKeyboardDelta: (delta) => set({ keyboardDelta: delta }),

  startBuilding: (taskId, ghostStart, ghostFinish) =>
    set({ phase: 'building', buildingTaskId: taskId, buildingStart: ghostStart, buildingFinish: ghostFinish }),

  stopBuilding: () =>
    set({ phase: 'idle', buildingTaskId: null, buildingStart: null, buildingFinish: null }),
}));
