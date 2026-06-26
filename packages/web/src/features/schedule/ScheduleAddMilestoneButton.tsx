export interface ScheduleAddMilestoneButtonProps {
  onAddMilestone: () => void;
  /** True when the user has read-only access — button renders disabled. */
  disabled?: boolean;
  /** True while the create mutation is in flight — prevents double-fire. */
  pending?: boolean;
}

/**
 * Toolbar peer to "+ Task" — opens a new milestone row at today's date.
 * Outlined-ghost variant per `packages/web/CLAUDE.md` rule §39 with the gold
 * `--brand-accent` token.
 *
 * Pairs with the ⌘M / Ctrl+M keyboard shortcut wired in ScheduleView via
 * `useScheduleKeyboard`. Both surfaces share the same `onAddMilestone` handler.
 */
export function ScheduleAddMilestoneButton({
  onAddMilestone,
  disabled = false,
  pending = false,
}: ScheduleAddMilestoneButtonProps) {
  const isDisabled = disabled || pending;
  return (
    <button
      type="button"
      onClick={onAddMilestone}
      disabled={isDisabled}
      aria-label="Add new milestone (Cmd+M)"
      title={disabled ? 'Read-only access' : 'Add new milestone (⌘M)'}
      data-testid="add-milestone-button"
      className={[
        'inline-flex h-7 px-3 items-center gap-1.5 rounded-control text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface',
        disabled
          ? 'bg-neutral-surface-sunken text-neutral-text-disabled border border-neutral-border cursor-not-allowed'
          : pending
            ? 'bg-brand-accent/15 border border-brand-accent text-brand-accent cursor-wait opacity-70'
            : 'bg-transparent border border-brand-accent/40 text-brand-accent hover:border-brand-accent hover:bg-brand-accent/10',
      ].join(' ')}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        {/* 45°-rotated square = diamond, matches the canvas milestone glyph */}
        <polygon points="7,0 14,7 7,14 0,7" />
      </svg>
      + Milestone
    </button>
  );
}
