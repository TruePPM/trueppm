import { renderHook } from '@testing-library/react';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { useSidebarCollapseHotkey } from './useSidebarCollapseHotkey';
import { useShellStore } from '@/stores/shellStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';

/**
 * Dispatch a ⌘/Ctrl+B keydown from `target` (defaults to document.body).
 * `meta: false` lets a test fire a bare `b` to prove the modifier is required.
 */
function pressToggle(
  target: EventTarget = document.body,
  init: Partial<KeyboardEventInit> = { metaKey: true },
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'b',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('useSidebarCollapseHotkey', () => {
  beforeEach(() => {
    useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
    useCommandPaletteStore.setState({ open: false });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('toggles the sidebar on ⌘B (and back on a second press)', () => {
    renderHook(() => useSidebarCollapseHotkey());

    pressToggle(document.body, { metaKey: true });
    expect(useShellStore.getState().sidebarCollapsed).toBe(true);
    expect(useShellStore.getState().sidebarUserControlled).toBe(true);

    pressToggle(document.body, { metaKey: true });
    expect(useShellStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggles on Ctrl+B for non-Mac platforms', () => {
    renderHook(() => useSidebarCollapseHotkey());
    pressToggle(document.body, { ctrlKey: true });
    expect(useShellStore.getState().sidebarCollapsed).toBe(true);
  });

  it('preventDefault stops the browser bold chord', () => {
    renderHook(() => useSidebarCollapseHotkey());
    const event = pressToggle(document.body, { metaKey: true });
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores a bare "b" with no modifier', () => {
    renderHook(() => useSidebarCollapseHotkey());
    pressToggle(document.body, {});
    expect(useShellStore.getState().sidebarCollapsed).toBe(false);
  });

  it('ignores Shift+⌘B and Alt+⌘B (chords reserved for other bindings)', () => {
    renderHook(() => useSidebarCollapseHotkey());
    pressToggle(document.body, { metaKey: true, shiftKey: true });
    pressToggle(document.body, { metaKey: true, altKey: true });
    expect(useShellStore.getState().sidebarCollapsed).toBe(false);
  });

  it('does not steal the chord while typing in an editable target (⌘B = bold)', () => {
    renderHook(() => useSidebarCollapseHotkey());
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = pressToggle(input, { metaKey: true });
    expect(useShellStore.getState().sidebarCollapsed).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores the chord while the command palette is open', () => {
    useCommandPaletteStore.setState({ open: true });
    renderHook(() => useSidebarCollapseHotkey());
    pressToggle(document.body, { metaKey: true });
    expect(useShellStore.getState().sidebarCollapsed).toBe(false);
  });

  it('detaches its listener on unmount', () => {
    const { unmount } = renderHook(() => useSidebarCollapseHotkey());
    unmount();
    pressToggle(document.body, { metaKey: true });
    expect(useShellStore.getState().sidebarCollapsed).toBe(false);
  });
});
