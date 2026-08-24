import { useRapidCompose } from './useRapidCompose';

export interface MobileComposeBarProps {
  /**
   * Where a committed row lands, in the user's words — "Backlog", "To Do".
   * Stated on the bar rather than assumed: the destination is derived from the
   * column swiped into view, so it changes under the user without them
   * touching anything that looks like a setting.
   */
  destinationLabel: string;
  /**
   * Commit a typed name. `opts.onError` restores the optimistically-cleared
   * text — the bar clears on submit so a second item can be typed immediately,
   * and a silent POST failure would otherwise lose it with no trace (#2030).
   */
  onCommit: (name: string, opts?: { onError?: () => void }) => void;
  /** True while a create is in flight — the field and Add button go inert. */
  isPending?: boolean;
  /** Dismiss the bar. The FAB is what brings it back. */
  onClose: () => void;
}

/**
 * The touch compose bar (#2952, design `v6-cases.js` case 18).
 *
 * The mobile FAB used to open `TaskFormModal` as a full-screen bottom sheet:
 * a phone-sized form with a name, a description, an assignee, a date and a
 * status, to add one row. This is the same trade the shell's `+ New task`
 * demotion already made (#2031) — a name is the only field the plan actually
 * needs, and everything else is one tap away in the task drawer on the row that
 * now exists.
 *
 * What a bar buys over a sheet, specifically: it does not cover the board. The
 * sheet's own destination was the column *behind* it, which the user could no
 * longer see; the bar leaves that column on screen and names it in the label,
 * so "where does this land" is answered by looking rather than by remembering.
 *
 * It stays open after a commit, with the caret kept, because intake on a phone
 * is bursty — a site walk produces five items, not one. That is the same
 * rapid-fire contract the backlog rail's capture field already has.
 */
export function MobileComposeBar({
  destinationLabel,
  onCommit,
  isPending = false,
  onClose,
}: MobileComposeBarProps) {
  // The rapid-fire contract — optimistic clear, error restore, container-bound
  // Escape, readOnly-not-disabled — lives in the hook, shared verbatim with the
  // lane compose field so the board's two capture surfaces cannot drift (#2952).
  const compose = useRapidCompose({ onCommit, isPending, onClose });

  return (
    <div
      // Sits ON the 56px bottom nav (`h-14`), not over the board — the whole
      // point is that the destination column stays visible above it.
      className="fixed bottom-14 inset-x-0 z-20 md:hidden border-t border-neutral-border
        bg-neutral-surface-raised px-3 py-2"
      ref={compose.containerRef}
      data-testid="mobile-compose-bar"
    >
      <div className="flex items-center justify-between pb-1.5">
        <span className="text-xs text-neutral-text-secondary">
          Lands in{' '}
          <span className="font-semibold text-neutral-text-primary">{destinationLabel}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close compose bar"
          // 24px glyph + invisible expander to the 44px touch floor (rule 5).
          className="relative inline-flex items-center justify-center rounded-control
            text-neutral-text-secondary hover:text-neutral-text-primary
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            before:absolute before:inset-[-10px] before:content-['']"
          style={{ width: 24, height: 24 }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <form
        aria-label={`Add a task to ${destinationLabel}`}
        onSubmit={(e) => {
          e.preventDefault();
          compose.commit();
        }}
        className="flex items-center gap-2"
      >
        <input
          ref={compose.inputRef}
          type="text"
          value={compose.value}
          onChange={(e) => compose.setValue(e.target.value)}
          onKeyDown={compose.onInputKeyDown}
          // `readOnly`, never `disabled` — see useRapidCompose.
          readOnly={isPending}
          placeholder="Name a task, then press Enter"
          aria-label={`Task name — lands in ${destinationLabel}`}
          aria-keyshortcuts="Enter Escape"
          className="flex-1 min-w-0 rounded-control border border-neutral-border bg-neutral-surface
            px-3 text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary
            focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary
            read-only:cursor-progress"
          // 44px touch floor (rule 5) — this is the primary phone input.
          style={{ height: 44 }}
        />
        <button
          type="submit"
          disabled={compose.submitDisabled}
          aria-busy={isPending}
          className="shrink-0 rounded-control bg-brand-primary px-4 text-sm font-semibold
            text-neutral-text-inverse
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary
            disabled:cursor-not-allowed"
          style={{ height: 44, minWidth: 64 }}
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </form>
    </div>
  );
}
