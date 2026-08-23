import type { FocusMode } from './useScheduleFocus';
import { formatChord } from '@/lib/platform';

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
    { key: '⏎', label: 'New row below' },
    { key: formatChord('alt+ArrowRight'), label: 'Indent' },
    { key: 'F2', label: 'Edit' },
  ],
  CellEdit: [
    { key: '⏎', label: 'Save' },
    { key: 'Esc', label: 'Cancel' },
    { key: '⇥', label: 'Next field' },
  ],
};

/**
 * Shown whenever a multi-row selection exists, in place of the mode hints and
 * regardless of `mode` (#2987).
 *
 * ⌘⇧K was reachable only by pressing `?` — it is in the cheatsheet, labeled
 * "Edit every selected row", which never says *schedule* and is a key-press away
 * from a planner who does not know the sheet exists. The moment a multi-row
 * selection exists is precisely the moment the chord means something, so that is
 * where it is advertised.
 */
const SELECTION_HINTS: HintEntry[] = [
  // First, because it is the act the selection was most likely built FOR (#2955) —
  // and because with `displayOptions.structureButtons` off by default, this strip is
  // where the chord is discoverable at the moment it becomes meaningful.
  { key: formatChord('mod+alt+g'), label: 'Group into a phase' },
  { key: formatChord('mod+shift+k'), label: 'Edit all selected' },
  { key: '⌫', label: 'Delete all selected' },
  { key: 'Esc', label: 'Clear selection' },
];

export interface BuildModeHintStripProps {
  mode: FocusMode;
  /**
   * Size of the current multi-row selection. Above 1 the strip shows the
   * selection hints instead of the mode hints — the mode is still RowFocused,
   * but what the planner can now do is a batch act, not a row act.
   */
  selectionCount?: number;
  /** Called when the "All shortcuts" affordance is clicked / activated. */
  onShowCheatsheet: () => void;
}

function HintChip({ entry }: { entry: HintEntry }) {
  return (
    <span className="inline-flex items-center">
      <kbd className="inline-flex h-5 px-1.5 items-center rounded-chip border border-chrome-border bg-chrome-surface text-xs tppm-mono text-chrome-text-primary">
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
export function BuildModeHintStrip({
  mode,
  selectionCount = 0,
  onShowCheatsheet,
}: BuildModeHintStripProps) {
  const multiSelect = selectionCount > 1;
  const hints = multiSelect ? SELECTION_HINTS : HINTS_BY_MODE[mode];
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
      data-selection-count={selectionCount}
      className="hidden md:flex h-7 items-center gap-4 px-3
        bg-chrome-surface-raised border-t border-chrome-border
        motion-safe:animate-save-bar-slide"
    >
      <span className="inline-flex items-center gap-1.5 text-xs uppercase tracking-widest text-chrome-text-secondary">
        <span aria-hidden="true">⌨</span>
        Build mode
      </span>
      <span className="text-chrome-text-secondary" aria-hidden="true">·</span>
      <div className="flex items-center gap-4 flex-1 min-w-0 overflow-hidden">
        {hints.map((entry) => (
          <HintChip key={`${multiSelect ? 'sel' : mode}-${entry.key}`} entry={entry} />
        ))}
      </div>
      <button
        type="button"
        onClick={onShowCheatsheet}
        className="inline-flex items-center gap-1.5 text-[12px] text-chrome-text-secondary
          hover:text-chrome-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface-raised rounded-control"
        aria-label="Show all keyboard shortcuts"
      >
        <kbd className="inline-flex h-5 px-1.5 items-center rounded-chip border border-chrome-border bg-chrome-surface text-xs tppm-mono">
          ?
        </kbd>
        All shortcuts
      </button>
    </div>
  );
}
