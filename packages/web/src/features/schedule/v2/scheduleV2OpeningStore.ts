import { create } from 'zustand';

/**
 * Shell v2 opening-state bookkeeping (#5106): which expanded phases the reader
 * has asked to show in full, and how many children the 10-row cap is hiding
 * under each. The Schedule writes the hidden counts; a phase row reads its own
 * and renders the "N more" chip. A store, not a prop, because the row sits four
 * components below the one that derives the visible set.
 */
interface OpeningState {
  showAll: Set<string>;
  hiddenByParent: Map<string, number>;
  /** Show the whole subtree of a capped phase. */
  revealAll: (parentId: string) => void;
  setHidden: (next: Map<string, number>) => void;
  reset: () => void;
}

export const useScheduleV2OpeningStore = create<OpeningState>((set) => ({
  showAll: new Set<string>(),
  hiddenByParent: new Map<string, number>(),
  revealAll: (parentId) =>
    set((s) => {
      const next = new Set(s.showAll);
      next.add(parentId);
      return { showAll: next };
    }),
  setHidden: (next) =>
    set((s) => {
      if (
        s.hiddenByParent.size === next.size &&
        [...next].every(([k, v]) => s.hiddenByParent.get(k) === v)
      )
        return s;
      return { hiddenByParent: next };
    }),
  reset: () => set({ showAll: new Set<string>(), hiddenByParent: new Map<string, number>() }),
}));
