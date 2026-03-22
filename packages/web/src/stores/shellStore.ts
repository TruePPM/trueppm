import { create } from 'zustand';

interface ShellState {
  sidebarCollapsed: boolean;
  /** Whether the user manually set the collapsed state (prevents auto-collapse from overriding) */
  sidebarUserControlled: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean, userControlled?: boolean) => void;
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
}));

/** Derived selector — use instead of re-deriving at call sites */
export function selectSidebarWidth(state: ShellState): 60 | 220 {
  return state.sidebarCollapsed ? 60 : 220;
}
