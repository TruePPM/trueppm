import { createContext, useContext, type ReactNode } from 'react';
import type { UseScheduleFocusReturn } from './useScheduleFocus';

export interface BuildModeApi {
  focus: UseScheduleFocusReturn;
  /** Indent the row (Tab from RowFocused). */
  indent: (taskId: string) => void;
  /** Outdent the row (Shift-Tab from RowFocused). */
  outdent: (taskId: string) => void;
  /** Insert a sibling row below the current row (Enter from RowFocused). */
  insertBelow: (taskId: string) => void;
  /** Convert a task to a milestone (set duration=0). Used by the row menu. */
  convertToMilestone: (taskId: string) => void;
  /** Delete a task. Used by the row menu and the Delete key. */
  deleteTask: (taskId: string) => void;
  /** True when an indent/outdent mutation is in flight for the given task. */
  isMutationPending: (taskId: string) => boolean;
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
