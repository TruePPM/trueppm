import { create } from 'zustand';

interface WbsStoreState {
  expandedIds: Set<string>;
  selectedTaskId: string | null;
  toggle: (id: string) => void;
  expandAll: (ids: string[]) => void;
  collapseAll: () => void;
  setSelectedTaskId: (id: string | null) => void;
}

export const useWbsStore = create<WbsStoreState>((set) => ({
  expandedIds: new Set<string>(),
  selectedTaskId: null,

  toggle: (id) =>
    set((s) => {
      const next = new Set(s.expandedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { expandedIds: next };
    }),

  expandAll: (ids) => set({ expandedIds: new Set(ids) }),

  collapseAll: () => set({ expandedIds: new Set<string>() }),

  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
}));
