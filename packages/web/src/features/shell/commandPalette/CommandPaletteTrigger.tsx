import { SearchIcon } from '@/components/Icons';
import { modifierKeyLabel } from '@/lib/platform';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';

/**
 * The visible affordance that opens the ⌘K command palette (v2 design system) —
 * the replacement for the legacy bare search icon (handoff "what changed" #3).
 * Lives in the top bar for now; it moves to the v2 left-rail ⌘K slot when the
 * shell lands. Hidden on narrow viewports where the keyboard shortcut and the
 * bottom nav cover navigation.
 */
export function CommandPaletteTrigger() {
  const setOpen = useCommandPaletteStore((s) => s.setOpen);

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Search or jump to (command palette)"
      aria-keyshortcuts="Meta+K Control+K"
      className="hidden sm:flex items-center gap-2 h-8 min-w-[200px] rounded-control border border-neutral-border bg-neutral-surface px-2.5 text-neutral-text-secondary
        hover:border-neutral-border hover:text-neutral-text-primary
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      <SearchIcon className="h-4 w-4 shrink-0" />
      <span className="text-[13px]">Search or jump to…</span>
      <kbd className="tppm-mono ml-auto shrink-0 rounded-chip border border-neutral-border px-1.5 py-0.5 text-[11px]">
        {modifierKeyLabel()}K
      </kbd>
    </button>
  );
}
