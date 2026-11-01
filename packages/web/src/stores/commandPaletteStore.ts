import { create } from 'zustand';

/**
 * Open/close state for the ⌘K command palette (v2 design system). A store rather than
 * local state so multiple triggers (the global hotkey, the context-bar search
 * affordance, and — once the v2 rail lands — the rail ⌘K trigger) all drive the
 * same overlay without prop-drilling.
 */
/** The task an inline "Log time" palette action is targeting (#1211). */
export interface LogTimeTarget {
  taskId: string;
  /** Display label naming the task in the form heading and the success toast. */
  taskLabel: string;
}

interface CommandPaletteState {
  open: boolean;
  /** Set by the "Log time on <task>" action to swap the palette body for the
   *  inline minutes form; cleared whenever the palette closes. */
  logTimeTarget: LogTimeTarget | null;
  setOpen: (open: boolean) => void;
  setLogTimeTarget: (target: LogTimeTarget | null) => void;
  toggle: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>()((set) => ({
  open: false,
  logTimeTarget: null,
  // Closing (or reopening) always drops the inline form so the palette never
  // reopens stuck on a stale target.
  setOpen: (open) => set({ open, logTimeTarget: null }),
  setLogTimeTarget: (logTimeTarget) => set({ logTimeTarget }),
  toggle: () => set((s) => ({ open: !s.open, logTimeTarget: null })),
}));
