import { create } from 'zustand';

/**
 * Open/close state for the ⌘K command palette (v2 design system). A store rather than
 * local state so multiple triggers (the global hotkey, the context-bar search
 * affordance, and — once the v2 rail lands — the rail ⌘K trigger) all drive the
 * same overlay without prop-drilling.
 */
interface CommandPaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
