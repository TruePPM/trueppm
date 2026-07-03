export interface BuildModePillProps {
  /** Called when the pill is clicked — opens the cheatsheet (same as `?` key). */
  onShowCheatsheet: () => void;
}

/**
 * Toolbar pill that signals "Schedule is in keyboard build mode" and opens the
 * cheatsheet on click. Provides the second discovery surface alongside the
 * always-visible bottom hint strip.
 */
export function BuildModePill({ onShowCheatsheet }: BuildModePillProps) {
  return (
    <button
      type="button"
      onClick={onShowCheatsheet}
      data-testid="build-mode-pill"
      aria-label="Build mode active. Press ? for keyboard shortcuts."
      // shrink-0 + whitespace-nowrap keep the pill a fixed size in the
      // flex-nowrap toolbar (web-rule 113) — without them it absorbs the
      // toolbar's shrinkage at high browser zoom and "Build mode" wraps (issue 1632).
      className="hidden md:inline-flex shrink-0 whitespace-nowrap h-7 px-2 items-center gap-1.5 rounded-control
        border border-brand-primary/30 bg-brand-primary/8 text-brand-primary
        text-xs font-medium uppercase tracking-widest
        hover:bg-brand-primary/12
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
        focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface"
    >
      <span aria-hidden="true">⌨</span>
      Build mode
    </button>
  );
}
