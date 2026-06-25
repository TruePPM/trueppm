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
      className="hidden md:inline-flex h-7 px-2 items-center gap-1.5 rounded-control
        border border-brand-primary/30 bg-brand-primary/8 text-brand-primary
        text-[11px] font-medium uppercase tracking-widest
        hover:bg-brand-primary/12
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
        focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface"
    >
      <span aria-hidden="true">⌨</span>
      Build mode
    </button>
  );
}
