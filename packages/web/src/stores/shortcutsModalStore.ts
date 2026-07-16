import { create } from 'zustand';

/**
 * Open/close state for the app-wide KeyboardShortcutsModal. A store rather than
 * local state so its two triggers — the UserMenu "Keyboard shortcuts" row and
 * the global `?` hotkey (useHelpShortcut) — drive one modal instance, rendered
 * once at the shell, without prop-drilling or two competing copies.
 */
interface ShortcutsModalState {
  open: boolean;
  openModal: () => void;
  closeModal: () => void;
}

export const useShortcutsModalStore = create<ShortcutsModalState>()((set) => ({
  open: false,
  openModal: () => set({ open: true }),
  closeModal: () => set({ open: false }),
}));
