import { create } from 'zustand';

/**
 * Selected program scope for the sidebar project list (issue #959, ADR — Direction C).
 * `'all'` shows every project, `'none'` shows projects with no program, any other
 * value is a program id. Held in the store (not local state) so the desktop sidebar
 * and the mobile drawer share one scope and stay in sync across remounts.
 */
export type ProjectScope = 'all' | 'none' | (string & {});

interface ShellState {
  sidebarCollapsed: boolean;
  /** Whether the user manually set the collapsed state (prevents auto-collapse from overriding) */
  sidebarUserControlled: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean, userControlled?: boolean) => void;
  projectScope: ProjectScope;
  setProjectScope: (scope: ProjectScope) => void;
}

export const useShellStore = create<ShellState>()((set) => ({
  sidebarCollapsed: false,
  sidebarUserControlled: false,
  toggleSidebar: () =>
    set((s) => ({
      sidebarCollapsed: !s.sidebarCollapsed,
      sidebarUserControlled: true,
    })),
  setSidebarCollapsed: (collapsed, userControlled = false) =>
    set({ sidebarCollapsed: collapsed, sidebarUserControlled: userControlled }),
  projectScope: 'all',
  setProjectScope: (scope) => set({ projectScope: scope }),
}));

/** Derived selector — use instead of re-deriving at call sites */
export function selectSidebarWidth(state: ShellState): 60 | 220 {
  return state.sidebarCollapsed ? 60 : 220;
}
