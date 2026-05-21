import { create } from 'zustand';

/**
 * Save-bar state lifted from the active settings page up to `SettingsShell`.
 *
 * Pages publish via `useDirtyForm`; the shell subscribes and renders the
 * save bar, confirm-discard dialog, and `beforeunload` listener.
 *
 * Only one page may be registered at a time. React Router renders one
 * `<Outlet/>` child at a time, so last-register-wins is safe — the previous
 * page unmounts and calls `reset()` in its cleanup before the next page
 * registers.
 */
export interface SettingsSaveState {
  /** True when the active page's current values differ from its initial values. */
  dirty: boolean;
  /** True when the active page has a working save mutation. False = stub page (inputs disabled). */
  apiReady: boolean;
  /** True while `onSave` is in flight. Buttons disable; nav guard short-circuits. */
  isSaving: boolean;
  /** Non-null after a save mutation rejects. Cleared on next dirty change or successful save. */
  saveError: string | null;
  /** Page-provided save handler. Returns a promise the store awaits. */
  onSave: (() => Promise<void> | void) | null;
  /** Page-provided reset handler — restores `values` to `initialValues`. */
  onReset: (() => void) | null;

  /** Page-side: called from `useDirtyForm` on mount and on every dependency change. */
  register: (opts: {
    dirty: boolean;
    apiReady: boolean;
    onSave: () => Promise<void> | void;
    onReset: () => void;
  }) => void;
  /** Page-side: called from `useDirtyForm` cleanup. */
  reset: () => void;
  /** Shell-side: invoked when the user clicks "Save changes" or presses Ctrl/Cmd+S. */
  triggerSave: () => Promise<void>;
  /** Shell-side: invoked when the user clicks "Discard" in the save bar. */
  triggerDiscard: () => void;
  /** Shell-side: clears the error banner without changing other state (e.g. on input change). */
  clearError: () => void;
}

const INITIAL: Pick<SettingsSaveState, 'dirty' | 'apiReady' | 'isSaving' | 'saveError' | 'onSave' | 'onReset'> = {
  dirty: false,
  apiReady: false,
  isSaving: false,
  saveError: null,
  onSave: null,
  onReset: null,
};

export const useSettingsSaveStore = create<SettingsSaveState>()((set, get) => ({
  ...INITIAL,

  register: ({ dirty, apiReady, onSave, onReset }) => {
    set((s) => ({
      dirty,
      apiReady,
      onSave,
      onReset,
      // Preserve in-flight save state and error across re-registrations within the same page mount
      isSaving: s.isSaving,
      saveError: dirty ? s.saveError : null,
    }));
  },

  reset: () => set(INITIAL),

  triggerSave: async () => {
    const { onSave, isSaving } = get();
    if (!onSave || isSaving) return;
    set({ isSaving: true, saveError: null });
    try {
      await onSave();
      // The page is responsible for bumping its initialValues snapshot,
      // which in turn re-renders useDirtyForm with `dirty=false`. We just
      // clear the saving flag.
      set({ isSaving: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      set({ isSaving: false, saveError: message });
    }
  },

  triggerDiscard: () => {
    const { onReset, isSaving } = get();
    if (!onReset || isSaving) return;
    onReset();
    // The page's reset() bumps current values back to initial; useDirtyForm
    // re-runs and publishes `dirty=false` on the next render.
  },

  clearError: () => set({ saveError: null }),
}));
