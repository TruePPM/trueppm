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
});

describe('selectSidebarWidth', () => {
  it('returns 248 when expanded', () => {
    const state = useShellStore.getState();
    useShellStore.setState({ sidebarCollapsed: false });
    expect(selectSidebarWidth(useShellStore.getState())).toBe(248);
    useShellStore.setState(state);
  });

  it('returns 0 when collapsed (hide-to-context-bar, ADR-0127)', () => {
    useShellStore.setState({ sidebarCollapsed: true });
    expect(selectSidebarWidth(useShellStore.getState())).toBe(0);
  });
});
