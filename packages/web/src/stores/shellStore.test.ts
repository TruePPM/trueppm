import { describe, expect, it, beforeEach } from 'vitest';
import { useShellStore, selectSidebarWidth } from './shellStore';

describe('useShellStore', () => {
  beforeEach(() => {
    useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
  });

  it('starts expanded', () => {
    expect(useShellStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggleSidebar collapses and marks user-controlled', () => {
    useShellStore.getState().toggleSidebar();
    const { sidebarCollapsed, sidebarUserControlled } = useShellStore.getState();
    expect(sidebarCollapsed).toBe(true);
    expect(sidebarUserControlled).toBe(true);
  });

  it('toggleSidebar expands when already collapsed', () => {
    useShellStore.setState({ sidebarCollapsed: true });
    useShellStore.getState().toggleSidebar();
    expect(useShellStore.getState().sidebarCollapsed).toBe(false);
  });

  it('setSidebarCollapsed sets state without marking user-controlled by default', () => {
    useShellStore.getState().setSidebarCollapsed(true);
    expect(useShellStore.getState().sidebarCollapsed).toBe(true);
    expect(useShellStore.getState().sidebarUserControlled).toBe(false);
  });

  it('setSidebarCollapsed marks user-controlled when flag passed', () => {
    useShellStore.getState().setSidebarCollapsed(true, true);
    expect(useShellStore.getState().sidebarUserControlled).toBe(true);
  });

  it('persists a user-controlled collapse to localStorage (ADR-0127)', () => {
    localStorage.removeItem('trueppm.rail.collapsed');
    useShellStore.getState().toggleSidebar();
    expect(JSON.parse(localStorage.getItem('trueppm.rail.collapsed') ?? '{}')).toEqual({
      collapsed: true,
    });
  });

  it('does NOT persist a viewport-driven (non-user-controlled) collapse', () => {
    localStorage.removeItem('trueppm.rail.collapsed');
    useShellStore.getState().setSidebarCollapsed(true, false);
    expect(localStorage.getItem('trueppm.rail.collapsed')).toBeNull();
  });

});

describe('selectSidebarWidth', () => {
  it('returns 248 when expanded', () => {
    const state = useShellStore.getState();
    useShellStore.setState({ sidebarCollapsed: false });
    expect(selectSidebarWidth(useShellStore.getState())).toBe(248);
    useShellStore.setState(state);
  });

  it('returns 64 when collapsed — icon-only, not hidden (ADR-0979)', () => {
    // Replaces the ADR-0127 assertion that this returned 0. Recorded as a
    // reversal rather than edited quietly: 0 meant the collapsed rail was an
    // `inert`, `aria-hidden` subtree that was absent for every user, and 64
    // means it is a live navigation landmark. Two Accepted ADRs (0127 D and
    // 0942 §10) were reversed to get here; if this assertion ever flips back,
    // it needs an ADR of its own, not a patch.
    useShellStore.setState({ sidebarCollapsed: true });
    expect(selectSidebarWidth(useShellStore.getState())).toBe(64);
  });

  it('never returns 0 — collapse no longer reclaims the full canvas (ADR-0979 §3)', () => {
    // The full-bleed need (the Schedule at export width) is deliberately NOT
    // served by the global collapse state any more; it wants its own focus mode.
    // Pinned so a future "just make it 0 again" is a visible decision.
    for (const sidebarCollapsed of [true, false]) {
      useShellStore.setState({ sidebarCollapsed });
      expect(selectSidebarWidth(useShellStore.getState())).toBeGreaterThan(0);
    }
  });
});
