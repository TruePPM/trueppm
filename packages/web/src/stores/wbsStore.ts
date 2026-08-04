import { create } from 'zustand';

interface WbsStoreState {
  expandedIds: Set<string>;
  selectedTaskId: string | null;
  toggle: (id: string) => void;
  expand: (ids: Iterable<string>) => void;
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

  // Additive, unlike `expandAll` — which REPLACES the whole set (its "expand
  // everything" callers always pass the full id list). Used by paste-many
  // (#2724) to reveal a newly-created subtree without collapsing whatever the
  // author already had open elsewhere in the outline.
  expand: (ids) =>
    set((s) => {
      const next = new Set(s.expandedIds);
      for (const id of ids) next.add(id);
      return { expandedIds: next };
    }),

  expandAll: (ids) => set({ expandedIds: new Set(ids) }),

  collapseAll: () => set({ expandedIds: new Set<string>() }),

  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
}));
