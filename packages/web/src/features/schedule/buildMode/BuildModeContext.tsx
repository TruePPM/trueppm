import { createContext, useContext, type ReactNode } from 'react';
import type { UseScheduleFocusReturn } from './useScheduleFocus';

export interface BuildModeApi {
  focus: UseScheduleFocusReturn;
  /** Indent the row (Alt+→ from RowFocused, #2727 — not Tab, see ADR-0776 §6). */
  indent: (taskId: string) => void;
  /** Outdent the row (Alt+← from RowFocused, #2727 — not Shift-Tab, see ADR-0776 §6). */
  outdent: (taskId: string) => void;
  /** Insert a sibling row below the current row (Enter from RowFocused). */
  insertBelow: (taskId: string) => void;
  /** Insert a sibling row above the current row (Shift+Enter, #2727). */
  insertAbove: (taskId: string) => void;
  /**
   * Insert a child row one level under the current row (⌘/Ctrl+Enter, #2727).
   * The current row becomes a summary as a side effect of gaining a child —
   * `isSummary` is server-derived from having children, not a settable flag.
   */
  insertChild: (taskId: string) => void;
  /** Convert a task to a milestone (set duration=0). Used by the row menu. */
  convertToMilestone: (taskId: string) => void;
  /** Delete a task. Used by the row menu and the Delete key. */
  deleteTask: (taskId: string) => void;
  /**
   * True when an indent / outdent / delete mutation is in flight for the
   * given task. Delete is included (#806) so the row gets the in-flight
   * treatment and the context-menu guards in `TaskListRow` fire before the
   * row unmounts on cache invalidation.
   */
  isMutationPending: (taskId: string) => boolean;
  /**
   * True for a task that `insertBelow` just created and whose Name has not
   * been touched yet. The row is created with a non-blank placeholder name
   * (the API rejects a blank one), but the Name cell renders empty for this
   * task so the UX and the double-Enter no-op guard both still read "blank
   * until typed" (#2682 follow-up). Optional — only `ScheduleView`'s real
   * wiring provides it; test mocks of `BuildModeApi` may omit it.
   */
  isPristineNewRow?: (taskId: string) => boolean;
  /** Marks a task as no longer pristine (first keystroke, commit, or rollback). */
  clearPristineNewRow?: (taskId: string) => void;
}

const BuildModeContext = createContext<BuildModeApi | null>(null);

export function BuildModeProvider({
  api,
  children,
}: {
  api: BuildModeApi;
  children: ReactNode;
}) {
  return <BuildModeContext.Provider value={api}>{children}</BuildModeContext.Provider>;
}

/**
 * Returns the build-mode API when a `<BuildModeProvider>` ancestor exists,
 * otherwise null. Components key off the null-check to switch between
 * flag-off (existing) and flag-on (build-mode) rendering paths.
 */
export function useBuildMode(): BuildModeApi | null {
  return useContext(BuildModeContext);
}
