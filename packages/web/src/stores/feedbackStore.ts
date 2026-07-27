/**
 * Open/closed state for the feedback dialog (#2392).
 *
 * A store rather than local state in `UserMenu` because two surfaces open the
 * same dialog — the user menu and the ⌘K palette — and the dialog itself is
 * mounted once in `AppShell`. Keeping it in the menu would mean the palette
 * could not reach it, and closing the menu would unmount the dialog mid-read.
 *
 * Nothing here is persisted: whether a dialog is open is not a preference.
 */
import { create } from 'zustand';

interface FeedbackState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useFeedbackStore = create<FeedbackState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
