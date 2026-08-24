import { formatChord } from '@/lib/platform';

export interface ScheduleAddPhaseButtonProps {
  onAddPhase: () => void;
  /** True when the user has read-only access — button renders disabled. */
  disabled?: boolean;
  /** True while the create mutation is in flight — prevents double-fire. */
  pending?: boolean;
  /**
   * The focused row this press would turn into a phase, or null (#2951).
   *
   * The control performs two different acts depending on what is focused, and a
   * keystroke or a label is a CLAIM that has to resolve against the act it names
   * (rule 326). "Add new phase, with its first task" is true only on the empty-focus
   * path; with a leaf focused the act is "make *this row* a phase", and a tooltip
   * that said otherwise would be describing a write the user is about to make to
   * a row it never mentions.
   */
  adoptsRowName?: string | null;
}

/**
 * Toolbar peer to "+ Item" / "+ Milestone" (epic #1752, issue #1754) — inserts
 * a new WBS summary row (a "phase-in-waiting" until it gains its first
 * structural child; ADR-0293) at the insertion point and drops straight into
 * inline name edit.
 *
 * The glyph is a summary-bar bracket (thin bar with downward end-caps),
 * matching the canvas `drawSummaryBar` rollup shape — deliberately distinct
 * from the milestone's gold diamond and the plain-bordered "+ Item" button so
 * the toolbar reads as three visually distinct creation affordances. Uses the
 * `--brand-primary` family, never gold (gold is reserved for milestone).
 *
 * Pairs with the ⌥⌘P / Ctrl+Alt+P keyboard shortcut wired in ScheduleView via
 * `useScheduleKeyboard`. Both surfaces share the same `onAddPhase` handler, which as
 * of #2955 creates the phase **with its first task** — a button never leaves an empty
 * phase behind — and does it as one recorded act, so ⌘Z takes the whole thing back.
 *
 * Since #2951 the handler has a second act: with a leaf row focused it adopts **that**
 * row as the container rather than making a new one, in a single `tasks/bulk` call. The
 * control therefore states which act the next press performs (`adoptsRowName`) instead
 * of naming only one of them.
 *
 * Behind `displayOptions.structureButtons` since #2955 and therefore **off by default**;
 * see `ScheduleStructureButtons` for why that is a ruling rather than an omission.
 */
export function ScheduleAddPhaseButton({
  onAddPhase,
  disabled = false,
  pending = false,
  adoptsRowName = null,
}: ScheduleAddPhaseButtonProps) {
  const isDisabled = disabled || pending;
  const chord = formatChord('mod+alt+p');
  // Derived once and used for BOTH the accessible name and the tooltip, so the two
  // cannot describe different acts (rule 316 — one phrasing, one owner).
  const action = adoptsRowName
    ? `Make ${adoptsRowName} a phase, with a task inside it`
    : 'Add new phase, with its first task';
  return (
    <button
      type="button"
      onClick={onAddPhase}
      disabled={isDisabled}
      aria-label={`${action} (${chord})`}
      title={disabled ? 'Read-only access' : `${action} (${chord})`}
      data-testid="add-phase-button"
      className={[
        // shrink-0 + whitespace-nowrap keep the button a fixed size in the
        // flex-nowrap toolbar (web-rule 113) — matches the milestone button's
        // zoom-reflow guard (issue 1632).
        'inline-flex h-7 px-3 items-center gap-1.5 rounded-control text-xs font-medium transition-colors shrink-0 whitespace-nowrap',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface',
        disabled
          ? 'bg-neutral-surface-sunken text-neutral-text-disabled border border-neutral-border cursor-not-allowed'
          : pending
            ? 'bg-brand-primary/15 border border-brand-primary text-brand-primary cursor-wait opacity-70'
            : 'bg-transparent border border-brand-primary/40 text-brand-primary hover:border-brand-primary hover:bg-brand-primary/10',
      ].join(' ')}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        {/* Summary-bar bracket: thin horizontal bar with downward triangular
            end-caps, mirroring the canvas summary/phase rollup bar shape. */}
        <rect x="1" y="4" width="12" height="2.25" rx="1" />
        <path d="M2 4 L2 8 L4.5 4 Z" />
        <path d="M12 4 L12 8 L9.5 4 Z" />
      </svg>
      + Phase
    </button>
  );
}
