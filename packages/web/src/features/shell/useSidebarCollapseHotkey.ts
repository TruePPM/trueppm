import { useEffect } from 'react';
import { useShellStore } from '@/stores/shellStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { isTypingInInput } from '@/hooks/useGlobalShortcut';

/**
 * Global ⌘B / Ctrl+B listener that toggles the sidebar rail (v2 design system,
 * ADR-0127). Mounted once at the shell, mirroring {@link useCommandPaletteHotkey}.
 * The collapse button's tooltip already advertises this chord — this hook is what
 * makes the advertised binding actually work (WCAG 2.1.1 for a documented shortcut).
 *
 * Unlike ⌘K, ⌘B is the OS-native "bold" chord inside rich-text / editable fields,
 * so we suppress it while the user is typing (so bolding a task description still
 * works) and while the command palette is open (the palette owns the keyboard).
 */
export function useSidebarCollapseHotkey(): void {
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'b') return;
      // Don't steal the chord from an editable target (⌘B = bold) or while the
      // command palette is capturing the keyboard.
      if (isTypingInInput(e.target)) return;
      if (useCommandPaletteStore.getState().open) return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);
}
