import { create } from 'zustand';

// Persisted rail prefs (v2 left rail, ADR-0126): expanded program ids (the
// Programs tree). localStorage so a refresh keeps the user's nav shape. Read
// defensively (private mode / SSR).
//
// Project and program *pins* used to live here too. They moved to the server in
// #2390 (ADR-0627) because a per-browser pin is not the same promise as a
// per-user one: the same person on a laptop and a phone saw two different rails.
// `usePins` now owns them; `usePinMigration` uploads whatever this store left in
// localStorage once per device.
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
 * Derived rail width. The v2 rail is 248px expanded and **64px icon-only**
 * collapsed (ADR-0979), which reverses ADR-0127 Decision D's 0px hide and
 * ADR-0942 §10.
 *
 * The union is the contract, not a decoration: at 0px the collapsed rail was an
 * `inert`, `aria-hidden` subtree — genuinely absent for every user — and at 64px
 * it is a live navigation landmark. ADR-0979 §2 is why: ⌘K answers "take me to
 * X" for someone who can already name X, and a rail answers "where am I, what
 * else is there, is anything waiting for me" for someone who is not asking a
 * question yet. A zero-width rail answers none of the three.
 *
 * Changing either arm changes what a collapsed rail *means*, so change it
 * against an ADR — see `Sidebar.tsx` for the a11y contract that rides on it.
 */
export function selectSidebarWidth(state: ShellState): 64 | 248 {
  return state.sidebarCollapsed ? 64 : 248;
}
