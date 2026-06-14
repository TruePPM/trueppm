import { useEffect } from 'react';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';

/**
 * Global ⌘K / Ctrl+K listener that toggles the command palette (v2 design system).
 * Mounted once at the shell. The chord works even while a text input is focused
 * (it is a deliberate meta/ctrl combo, not a bare key), so no input guard is
 * needed; we only `preventDefault` to stop the browser's own ⌘K.
 */
export function useCommandPaletteHotkey(): void {
  const toggle = useCommandPaletteStore((s) => s.toggle);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);
}
