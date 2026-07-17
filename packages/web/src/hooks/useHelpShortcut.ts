import { useEffect } from 'react';
import { isTypingInInput, isHelpShortcutClaimed } from '@/hooks/useGlobalShortcut';

/**
 * Global `?` listener that opens the app-wide KeyboardShortcutsModal from
 * anywhere. Mounted once at the shell (AppShell), mirroring
 * {@link useCommandPaletteHotkey} / {@link useSidebarCollapseHotkey}.
 *
 * Guards:
 * - Never fires while typing in an editable target (input/textarea/select/
 *   contenteditable/ARIA combobox) — a literal `?` there is text, not a command
 *   (shared {@link isTypingInInput} guard, #644).
 * - Ignores the chord when a modifier is held — ⌘?/Ctrl+?/Alt+? are not ours.
 * - Yields to a surface that already owns `?` (the Board KeyboardCheatsheet and
 *   the Schedule build-mode cheatsheet register a claim while mounted, checked
 *   via {@link isHelpShortcutClaimed}). This is deterministic precedence that
 *   does not depend on window-listener order or `preventDefault` timing — so
 *   `?` on the board opens only the board cheatsheet, never both.
 */
export function useHelpShortcut(onOpen: () => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '?') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingInInput(e.target)) return;
      // A surface (Board / Schedule build mode) owns `?` on its own screen — let
      // its cheatsheet win rather than double-firing the global modal.
      if (isHelpShortcutClaimed()) return;
      onOpen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpen]);
}
