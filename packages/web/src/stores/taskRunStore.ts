/**
 * Tracks active task runs received from WebSocket events.
 * Used by the global TaskRunIndicator and per-run progress consumers.
 */
import { create } from 'zustand';

export interface TaskRunEntry {
  taskRunId: string;
  taskName: string;
  projectId: string | null;
  pct: number | null;
  msg: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

interface TaskRunState {
  /** Active and recently-completed runs keyed by taskRunId. */
  runs: Record<string, TaskRunEntry>;
  /** Number of currently running/pending task runs. */
  activeCount: number;
  addRun: (entry: TaskRunEntry) => void;
  updateProgress: (taskRunId: string, pct: number, msg: string) => void;
  completeRun: (taskRunId: string, resultSummary: Record<string, unknown> | null) => void;
  failRun: (taskRunId: string, errorDetail: string) => void;
  cancelRun: (taskRunId: string) => void;
}

export const useTaskRunStore = create<TaskRunState>()((set) => ({
  runs: {},
  activeCount: 0,

  addRun: (entry) =>
    set((state) => ({
      runs: { ...state.runs, [entry.taskRunId]: entry },
      activeCount: state.activeCount + 1,
    })),

  updateProgress: (taskRunId, pct, msg) =>
    set((state) => {
      const existing = state.runs[taskRunId];
      if (!existing) return state;
      return {
        runs: {
          ...state.runs,
          [taskRunId]: { ...existing, pct, msg },
        },
      };
    }),

  completeRun: (taskRunId, _resultSummary) =>
    set((state) => {
      const existing = state.runs[taskRunId];
      if (!existing) return state;
      return {
        runs: {
          ...state.runs,
          [taskRunId]: { ...existing, status: 'completed', pct: 100 },
        },
        activeCount: Math.max(0, state.activeCount - 1),
      };
    }),

  failRun: (taskRunId, errorDetail) =>
    set((state) => {
      const existing = state.runs[taskRunId];
      if (!existing) return state;
      return {
        runs: {
          ...state.runs,
          [taskRunId]: { ...existing, status: 'failed', msg: errorDetail },
        },
        activeCount: Math.max(0, state.activeCount - 1),
      };
    }),

  cancelRun: (taskRunId) =>
    set((state) => {
      const existing = state.runs[taskRunId];
      if (!existing) return state;
      return {
        runs: {
          ...state.runs,
          [taskRunId]: { ...existing, status: 'cancelled' },
        },
        activeCount: Math.max(0, state.activeCount - 1),
      };
    }),
}));
