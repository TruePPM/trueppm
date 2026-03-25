import { create } from 'zustand';

export interface CpmError {
  error: 'cyclic_dependency' | 'internal_error';
  cycle: string[];
}

interface SchedulerState {
  /** True while the CPM engine is running (cpm_queued received, cpm_complete not yet received). */
  isRecalculating: boolean;
  /** Set when the server sends cpm_error; cleared on the next cpm_queued. */
  cpmError: CpmError | null;
  /** ISO timestamp of the most recent successful cpm_complete event. */
  recalculatedAt: string | null;
  setRecalculating: (isRecalculating: boolean) => void;
  setCpmError: (error: CpmError) => void;
  setCpmComplete: (recalculatedAt: string) => void;
  clearCpmError: () => void;
}

export const useSchedulerStore = create<SchedulerState>()((set) => ({
  isRecalculating: false,
  cpmError: null,
  recalculatedAt: null,
  setRecalculating: (isRecalculating) => set({ isRecalculating }),
  setCpmError: (error) => set({ isRecalculating: false, cpmError: error }),
  setCpmComplete: (recalculatedAt) =>
    set({ isRecalculating: false, cpmError: null, recalculatedAt }),
  clearCpmError: () => set({ cpmError: null }),
}));
