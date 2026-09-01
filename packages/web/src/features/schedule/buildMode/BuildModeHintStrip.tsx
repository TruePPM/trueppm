import type { FocusMode } from './useScheduleFocus';
import { formatChord } from '@/lib/platform';
import { countRows } from '../rowVocabulary';

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
 * What a reader is taught, in every focus state and at every selection size
 * (#3231).
 *
 * `buildModeActive = !isMobile`, and `tryBuildModeFocusMove` has no rights gate,
 * so a Viewer does reach `RowFocused` and used to be shown `HINTS_BY_MODE`'s
 * three mutations — `⏎ New row below`, indent, `F2 Edit` — none of which they
 * can perform. Web rule 302: a control a reader is not offered is **absent**,
 * not dimmed, and a hint for an act that cannot happen is worse than a dimmed
 * control because there is nothing on screen to look disabled. #3020 made the
 * argument for the two dead keystroke chips: a user who tries the thing the bar
 * teaches and gets nothing concludes the *feature* is broken, not the hint.
 *
 * Both entries are read off the row reducer's own reader branch
 * (`TaskListRow.tsx`, the `if (!canEdit)` arm) rather than chosen for tone:
 *
 *  - `↑↓` moves row focus through `tryBuildModeFocusMove`, which gates on
 *    `buildMode` alone — identical for a reader. The label is the one the
 *    shipped `NoSelection` set already uses, so the strip does not coin a
 *    second phrase for one act.
 *  - `⏎` falls into the reader branch, which sets `selectedTaskId` — the store
 *    the task drawer renders from. So it opens details; it does not insert.
 *    The cheatsheet already calls this act "Open the focused row's details".
 *
 * Deliberately *not* here: `Esc Clear selection`. Escape is handled inside the
 * authoring branch, so it is not a verified reader act, and a hint set whose
 * whole point is that every glyph resolves must not itself guess.
 *
 * Scope note: this branches on **edit rights**, not on `readOnly`. An author who
 * pressed the Read pill is a different state — the apparatus is genuinely theirs
 * and is one keystroke away (`ScheduleView` documents the distinction at
 * `hasEditRights`), and `shouldRenderCoachBar` already takes rights alone. What
 * that mode should teach is a live question owned by the mode-pill work, not
 * settled quietly here.
 */
const READER_HINTS: HintEntry[] = [
  { key: '↑↓', label: 'Select row' },
  { key: '⏎', label: 'Open details' },
];

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
  { key: '⌫', label: 'Delete all selected' },
  { key: 'Esc', label: 'Clear selection' },
];

export interface BuildModeHintStripProps {
  mode: FocusMode;
  /**
   * This reader may author. False replaces every mode/selection hint with
   * `READER_HINTS` — see there for why the strip stays up rather than being
   * withheld from a reader entirely (#3231).
   */
  hasEditRights: boolean;
  /**
   * Size of the current multi-row selection. Above 1 the strip shows the
   * selection hints instead of the mode hints — the mode is still RowFocused,
   * but what the planner can now do is a batch act, not a row act.
   */
  selectionCount?: number;
  /**
   * Open the bulk-edit sheet (`S23`, #3152). Absent for a reader who may not
   * author — a control that cannot act is worse than no control.
   *
   * This replaces the passive `⌘⇧K Edit all selected` hint chip that used to sit
   * here. A hint teaches a chord; a **control** performs the act and teaches the
   * chord beside it, which is why a richer sheet needed a stronger front door —
   * and why that door is a control rather than another teaching surface.
   */
  onBulkEdit?: () => void;
  /** Called when the "All shortcuts" affordance is clicked / activated. */
  onShowCheatsheet: () => void;
}

function HintChip({ entry }: { entry: HintEntry }) {
  return (
    <span className="inline-flex items-center">
      <kbd className="inline-flex h-5 px-1.5 items-center rounded-chip border border-chrome-border bg-chrome-surface text-xs tppm-mono text-chrome-text-primary">
        {entry.key}
      </kbd>
      <span className="ml-1.5 text-xs text-chrome-text-secondary">
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
  hasEditRights,
  selectionCount = 0,
  onBulkEdit,
  onShowCheatsheet,
}: BuildModeHintStripProps) {
  const multiSelect = selectionCount > 1;
  // Rights first: a reader gets the same two navigation hints in every focus
  // state, because the mode and selection sets are entirely mutations for them.
  const hints = !hasEditRights
    ? READER_HINTS
    : multiSelect
      ? SELECTION_HINTS
      : HINTS_BY_MODE[mode];
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
      data-hints={!hasEditRights ? 'reader' : multiSelect ? 'selection' : mode}
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
        {hasEditRights && multiSelect && onBulkEdit && (
          <button
            type="button"
            onClick={onBulkEdit}
            data-testid="build-mode-bulk-edit"
            // rule 214: `focus:`, not `focus-visible:` — Firefox and desktop
            // Safari withhold `:focus-visible` on pointer-initiated focus, which
            // leaves a standalone chrome control with no visible ring at all.
            className="inline-flex items-center gap-1.5 text-xs text-chrome-text-primary
              hover:text-brand-primary
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1 focus:ring-offset-chrome-surface-raised rounded-control"
          >
            Edit {countRows(selectionCount)}
            <kbd className="inline-flex h-5 px-1.5 items-center rounded-chip border border-chrome-border bg-chrome-surface text-xs tppm-mono">
              {formatChord('mod+shift+k')}
            </kbd>
          </button>
        )}
        {hints.map((entry) => (
          <HintChip key={`${multiSelect ? 'sel' : mode}-${entry.key}`} entry={entry} />
        ))}
      </div>
      <button
        type="button"
        onClick={onShowCheatsheet}
        // rule 214 — converted alongside the sibling control added in #3152
        // rather than carried forward.
        className="inline-flex items-center gap-1.5 text-xs text-chrome-text-secondary
          hover:text-chrome-text-primary
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1 focus:ring-offset-chrome-surface-raised rounded-control"
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
