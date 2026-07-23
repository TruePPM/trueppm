import { create } from 'zustand';

/**
 * Session-scoped memory of which task-detail drawer sections the user has
 * expanded or collapsed (#2049).
 *
 * The drawer unmounts and remounts on every task open, so a section's local
 * `useState` open flag is lost each time — forcing the "review estimates before
 * the Monte Carlo run" loop to re-expand the Estimates accordion for every task.
 * Keeping the choice here (module-level, keyed by the stable section `id`) lets
 * an expansion survive across drawer opens and across tasks for the session.
 *
 * `overrides[id]` is `undefined` until the user first toggles that section, so a
 * never-touched section still honors its `defaultOpen` — preserving the ADR-0050
 * lazy-load default (untouched sections stay collapsed and don't fire queries).
 * Only sections the user deliberately opened load eagerly on the next drawer open,
 * which is exactly the intent for the estimate-review loop.
 *
 * Intentionally in-memory (not sessionStorage): "per session" means the live SPA
 * session; a full page reload resetting to defaults is acceptable and avoids
 * serializing transient UI state.
 */
interface DrawerSectionState {
  overrides: Record<string, boolean>;
  setOpen: (id: string, open: boolean) => void;
  /**
   * Sections the user has revealed via the Details-tab "Add detail" affordance
   * (ADR-0605, #2315), keyed `${taskId}:${sectionId}`. Progressive disclosure
   * hides an *empty* optional section (`isPopulated` returned false) behind
   * "Add detail"; revealing it moves it back into the main flow. Keyed by task
   * so revealing Recurrence on task A does not reveal it on task B. Same
   * session-scoped, in-memory lifetime as `overrides` (a reload resets to the
   * populated-only default, which is acceptable transient UI state).
   */
  revealed: Record<string, boolean>;
  reveal: (taskId: string, id: string) => void;
}

/** Reveal-set key — task-scoped so a reveal never leaks across tasks. */
export function revealKey(taskId: string, id: string): string {
  return `${taskId}:${id}`;
}

export const useDrawerSectionStore = create<DrawerSectionState>((set) => ({
  overrides: {},
  setOpen: (id, open) => set((s) => ({ overrides: { ...s.overrides, [id]: open } })),
  revealed: {},
  reveal: (taskId, id) =>
    set((s) => ({ revealed: { ...s.revealed, [revealKey(taskId, id)]: true } })),
}));
