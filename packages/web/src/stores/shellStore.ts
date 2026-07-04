import { create } from 'zustand';

/**
 * Selected program scope for the sidebar project list (issue #959, ADR — Direction C).
 * `'all'` shows every project, `'none'` shows projects with no program, any other
 * value is a program id. Held in the store (not local state) so the desktop sidebar
 * and the mobile drawer share one scope and stay in sync across remounts.
 */
export type ProjectScope = 'all' | 'none' | (string & {});

// Persisted rail prefs (v2 left rail, ADR-0126): pinned project ids (Shortcuts)
// and expanded program ids (the Programs tree). localStorage so a refresh keeps
// the user's nav shape. Read defensively (private mode / SSR).
const PINNED_KEY = 'trueppm.rail.pinned';
const EXPANDED_KEY = 'trueppm.rail.expanded';
// Per-user pinned mobile BottomNav views (issue 1591): view keys the user
// promotes into the primary rail slots, ahead of the methodology defaults.
// localStorage (client-side prefs only, no API) mirrors the existing rail-pref
// pattern above. Overview + Today stay anchored, so pins fill the remaining
// primary slots (see bottomNavItems.ts).
const MOBILE_PINNED_VIEWS_KEY = 'trueppm.mobilenav.pinned';
function readIds(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeIds(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // localStorage unavailable — keep the in-memory value only.
  }
}

// Persisted rail collapse intent (ADR-0127). Only a *user-controlled* collapse is
// persisted — viewport-driven auto-collapse (< lg) is derived fresh on each mount,
// so it must not leak across reloads. On load we restore the user's choice and the
// `userControlled` flag so the mount-time resize handler won't override it.
const COLLAPSED_KEY = 'trueppm.rail.collapsed';
function readCollapsed(): { collapsed: boolean; userControlled: boolean } {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && 'collapsed' in parsed) {
      return {
        collapsed: Boolean((parsed as { collapsed: unknown }).collapsed),
        userControlled: true,
      };
    }
  } catch {
    // ignore — fall through to the default
  }
  return { collapsed: false, userControlled: false };
}
function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ collapsed }));
  } catch {
    // localStorage unavailable — keep the in-memory value only.
  }
}

interface ShellState {
  sidebarCollapsed: boolean;
  /** Whether the user manually set the collapsed state (prevents auto-collapse from overriding) */
  sidebarUserControlled: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean, userControlled?: boolean) => void;
  projectScope: ProjectScope;
  setProjectScope: (scope: ProjectScope) => void;
  /** Pinned project ids — the rail Shortcuts group (v2). Persisted. */
  pinnedProjectIds: string[];
  togglePin: (projectId: string) => void;
  /** Expanded program ids — the rail Programs tree (v2). Persisted. */
  expandedProgramIds: string[];
  toggleProgram: (programId: string) => void;
  /**
   * Mobile BottomNav views the user pinned into the primary rail (issue 1591).
   * Ordered by pin recency. Persisted per user (localStorage).
   */
  pinnedMobileViews: string[];
  /** Pin or unpin a view from the mobile primary rail. */
  toggleMobileViewPin: (view: string) => void;
}

const initialCollapse = readCollapsed();

export const useShellStore = create<ShellState>()((set) => ({
  sidebarCollapsed: initialCollapse.collapsed,
  sidebarUserControlled: initialCollapse.userControlled,
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      writeCollapsed(next);
      return { sidebarCollapsed: next, sidebarUserControlled: true };
    }),
  setSidebarCollapsed: (collapsed, userControlled = false) => {
    // Persist only deliberate (user-controlled) collapses — auto-collapse is
    // viewport-derived and recomputed on each mount.
    if (userControlled) writeCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed, sidebarUserControlled: userControlled });
  },
  projectScope: 'all',
  setProjectScope: (scope) => set({ projectScope: scope }),
  pinnedProjectIds: readIds(PINNED_KEY),
  togglePin: (projectId) =>
    set((s) => {
      const next = s.pinnedProjectIds.includes(projectId)
        ? s.pinnedProjectIds.filter((id) => id !== projectId)
        : [...s.pinnedProjectIds, projectId];
      writeIds(PINNED_KEY, next);
      return { pinnedProjectIds: next };
    }),
  expandedProgramIds: readIds(EXPANDED_KEY),
  toggleProgram: (programId) =>
    set((s) => {
      const next = s.expandedProgramIds.includes(programId)
        ? s.expandedProgramIds.filter((id) => id !== programId)
        : [...s.expandedProgramIds, programId];
      writeIds(EXPANDED_KEY, next);
      return { expandedProgramIds: next };
    }),
  pinnedMobileViews: readIds(MOBILE_PINNED_VIEWS_KEY),
  toggleMobileViewPin: (view) =>
    set((s) => {
      const next = s.pinnedMobileViews.includes(view)
        ? s.pinnedMobileViews.filter((v) => v !== view)
        : [...s.pinnedMobileViews, view];
      writeIds(MOBILE_PINNED_VIEWS_KEY, next);
      return { pinnedMobileViews: next };
    }),
}));

/**
 * Derived rail width. v2 rail is 248px expanded; collapsing now fully HIDES it
 * (0px, "hide-to-context-bar" per ADR-0127) — the re-open ≡ lives in the context
 * bar, with ⌘K as the jump-to power-nav. This supersedes the old 60px icon rail.
 */
export function selectSidebarWidth(state: ShellState): 0 | 248 {
  return state.sidebarCollapsed ? 0 : 248;
}
