import { create } from 'zustand';

/**
 * Save-bar state lifted from the active settings sections up to `SettingsShell`.
 *
 * Pages publish via `useDirtyForm`; the shell subscribes and renders the
 * save bar, confirm-discard dialog, and `beforeunload` listener.
 *
 * ADR-0146 — multi-section registry. The settings IA is now ONE mounted
 * scrolling page per entity (issue 1248), so several form sections register at the
 * same time. Each section registers under a stable key (`sectionId`); the
 * store keeps a per-key map and derives an aggregate dirty surface:
 *
 *   - `dirty`      = ANY registered section is dirty
 *   - `triggerSave`    = run `onSave` for EVERY dirty section (sequential)
 *   - `triggerDiscard` = run `onReset` for EVERY dirty section
 *
 * Sequential save (not Promise.all) keeps error attribution simple — the first
 * rejecting section surfaces its message and the run stops; already-saved
 * sections stay saved. Settings saves are infrequent and small, so the lack of
 * parallelism costs nothing.
 *
 * Standalone settings routes that are not part of the consolidated page (e.g.
 * the System Health "Retention & purge" tool) register under the default key,
 * which behaves exactly like the pre-0146 single-registration contract.
 */

/** Default registration key for sections rendered outside a `<SettingsSection>`. */
export const DEFAULT_SECTION_KEY = '__default__';

interface SectionEntry {
  dirty: boolean;
  apiReady: boolean;
  onSave: () => Promise<void> | void;
  onReset: () => void;
}

export interface SettingsSaveState {
  /** Per-section registry, keyed by `sectionId`. */
  sections: Record<string, SectionEntry>;
  /** True when the active section's current values differ from its initial values. */
  dirty: boolean;
  /** True when at least one registered section has a working save mutation. */
  apiReady: boolean;
  /** True while a save run is in flight. Buttons disable; nav guard short-circuits. */
  isSaving: boolean;
  /** Non-null after a save mutation rejects. Cleared on next dirty change or successful save. */
  saveError: string | null;
  /**
   * Epoch ms of the most recent fully-successful save, or null. Cleared when the
   * surface goes clean→registers fresh so the "Saved [time]" footer is scoped to
   * the current page mount.
   */
  lastSavedAt: number | null;

  /** Page-side: called from `useDirtyForm` on mount and on every dependency change. */
  register: (
    sectionId: string,
    opts: {
      dirty: boolean;
      apiReady: boolean;
      onSave: () => Promise<void> | void;
      onReset: () => void;
    },
  ) => void;
  /** Page-side: called from `useDirtyForm` cleanup — removes only this section. */
  unregister: (sectionId: string) => void;
  /** Test/legacy alias for a full reset of the registry. */
  reset: () => void;
  /** Shell-side: invoked when the user clicks "Save changes" or presses Ctrl/Cmd+S. */
  triggerSave: () => Promise<void>;
  /** Shell-side: invoked when the user clicks "Discard" in the save bar. */
  triggerDiscard: () => void;
  /** Shell-side: clears the error banner without changing other state. */
  clearError: () => void;
}

const INITIAL: Pick<
  SettingsSaveState,
  'sections' | 'dirty' | 'apiReady' | 'isSaving' | 'saveError' | 'lastSavedAt'
> = {
  sections: {},
  dirty: false,
  apiReady: false,
  isSaving: false,
  saveError: null,
  lastSavedAt: null,
};

/** Recompute the aggregate `dirty` / `apiReady` flags from the section registry. */
function aggregate(sections: Record<string, SectionEntry>): {
  dirty: boolean;
  apiReady: boolean;
} {
  let dirty = false;
  let apiReady = false;
  for (const entry of Object.values(sections)) {
    if (entry.dirty) dirty = true;
    if (entry.apiReady) apiReady = true;
  }
  return { dirty, apiReady };
}

export const useSettingsSaveStore = create<SettingsSaveState>()((set, get) => ({
  ...INITIAL,

  register: (sectionId, { dirty, apiReady, onSave, onReset }) => {
    set((s) => {
      const sections = { ...s.sections, [sectionId]: { dirty, apiReady, onSave, onReset } };
      const agg = aggregate(sections);
      return {
        sections,
        dirty: agg.dirty,
        apiReady: agg.apiReady,
        // Preserve in-flight + last-saved across re-registers within a mount.
        isSaving: s.isSaving,
        // Clear a stale error once nothing is dirty anymore.
        saveError: agg.dirty ? s.saveError : null,
        lastSavedAt: s.lastSavedAt,
      };
    });
  },

  unregister: (sectionId) => {
    set((s) => {
      if (!(sectionId in s.sections)) return s;
      const sections = { ...s.sections };
      delete sections[sectionId];
      const agg = aggregate(sections);
      return {
        sections,
        dirty: agg.dirty,
        apiReady: agg.apiReady,
        saveError: agg.dirty ? s.saveError : null,
      };
    });
  },

  reset: () => set({ ...INITIAL, sections: {} }),

  triggerSave: async () => {
    const { sections, isSaving } = get();
    if (isSaving) return;
    const dirtySections = Object.values(sections).filter((e) => e.dirty);
    if (dirtySections.length === 0) return;
    set({ isSaving: true, saveError: null });
    try {
      // Sequential: a rejection stops the run with the failing section's message;
      // sections saved before it stay saved (their pages bump their own snapshot).
      for (const entry of dirtySections) {
        await entry.onSave();
      }
      set({ isSaving: false, lastSavedAt: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      set({ isSaving: false, saveError: message });
    }
  },

  triggerDiscard: () => {
    const { sections, isSaving } = get();
    if (isSaving) return;
    for (const entry of Object.values(sections)) {
      if (entry.dirty) entry.onReset();
    }
    // Each section's reset() bumps its values back to initial; useDirtyForm
    // re-runs and re-registers with dirty=false on the next render.
  },

  clearError: () => set({ saveError: null }),
}));
