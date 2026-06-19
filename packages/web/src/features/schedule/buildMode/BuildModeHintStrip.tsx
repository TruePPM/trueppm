import type { FocusMode } from './useScheduleFocus';

interface HintEntry {
  /** Glyph or short string rendered inside the <kbd> chip. */
  key: string;
  /** Plain-language label describing what the key does. */
  label: string;
}

const HINTS_BY_MODE: Record<FocusMode, HintEntry[]> = {
  NoSelection: [
    { key: '↑↓', label: 'Select row' },
    { key: 'Click', label: 'Edit cell' },
    { key: '?', label: 'All shortcuts' },
  ],
  RowFocused: [
    { key: 'Enter', label: 'Edit' },
    { key: 'Tab', label: 'Indent' },
    { key: '⏎', label: 'New row below' },
  ],
  CellEdit: [
    { key: '⏎', label: 'Save' },
    { key: 'Esc', label: 'Cancel' },
    { key: '⇥', label: 'Next field' },
  ],
};

export interface BuildModeHintStripProps {
  mode: FocusMode;
  /** Called when the "All shortcuts" affordance is clicked / activated. */
  onShowCheatsheet: () => void;
}

function HintChip({ entry }: { entry: HintEntry }) {
  return (
    <span className="inline-flex items-center">
      <kbd className="inline-flex h-5 px-1.5 items-center rounded border border-chrome-border bg-chrome-surface text-[11px] tppm-mono text-chrome-text-primary">
        {entry.key}
      </kbd>
      <span className="ml-1.5 text-[12px] text-chrome-text-secondary">
        {entry.label}
      </span>
    </span>
  );
}

/**
 * Bottom-of-Schedule hint strip — three focus-state-aware hotkey hints plus
 * a `? All shortcuts` affordance to open the cheatsheet.
 *
 * Mounting is contextual (#1250, web rule 194): ScheduleView renders this only
 * while the user is engaged (RowFocused / CellEdit), so the idle Schedule reclaims
 * the vertical band for ScheduleForecastBar. The always-on toolbar `BuildModePill`
 * — not this strip — is the persistent discovery affordance for first-time users.
 * The component stays total over `FocusMode` (it still renders NoSelection hints
 * when exercised directly) so callers, not the component, own the reveal policy.
 */
export function BuildModeHintStrip({ mode, onShowCheatsheet }: BuildModeHintStripProps) {
  const hints = HINTS_BY_MODE[mode];
  return (
    <div
      // No live-region semantics (web rule 194): now that ScheduleView mounts
      // this strip contextually, a `role="status"` would re-announce on every
      // NoSelection→RowFocused / RowFocused↔CellEdit transition — aria-live
      // churn for decorative discovery chrome. The build-mode signal AT users
      // need is the always-on toolbar pill (clear aria-label) and the fully
      // accessible cheatsheet; the chips here are visual reinforcement. The
      // strip stays in the reading order and its cheatsheet button keeps its
      // own accessible name, so nothing is hidden — it just isn't auto-spoken.
      data-testid="build-mode-hint-strip"
      data-mode={mode}
      className="hidden md:flex h-7 items-center gap-4 px-3
        bg-chrome-surface-raised border-t border-chrome-border
        motion-safe:animate-save-bar-slide"
    >
      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-chrome-text-secondary">
        <span aria-hidden="true">⌨</span>
        Build mode
      </span>
      <span className="text-chrome-text-secondary" aria-hidden="true">·</span>
      <div className="flex items-center gap-4 flex-1 min-w-0 overflow-hidden">
        {hints.map((entry) => (
          <HintChip key={`${mode}-${entry.key}`} entry={entry} />
        ))}
      </div>
      <button
        type="button"
        onClick={onShowCheatsheet}
        className="inline-flex items-center gap-1.5 text-[12px] text-chrome-text-secondary
          hover:text-chrome-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface-raised rounded"
        aria-label="Show all keyboard shortcuts"
      >
        <kbd className="inline-flex h-5 px-1.5 items-center rounded border border-chrome-border bg-chrome-surface text-[11px] tppm-mono">
          ?
        </kbd>
        All shortcuts
      </button>
    </div>
  );
}
