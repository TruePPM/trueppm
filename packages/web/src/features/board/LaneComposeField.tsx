import { useRapidCompose } from './useRapidCompose';

export interface LaneComposeFieldProps {
  /** The lane this field is filing into, in the user's words — "Mobilization". */
  laneName: string;
  /** The column a committed row lands in — "To Do", "Backlog". */
  destinationLabel: string;
  /** Commit a typed name. `opts.onError` restores the optimistically-cleared text. */
  onCommit: (name: string, opts?: { onError?: () => void }) => void;
  /** True while a create is in flight — the field goes inert but keeps focus. */
  isPending?: boolean;
  /** Dismiss the field. The lane's `+` is what brings it back. */
  onClose: () => void;
}

/**
 * One-field capture inside a board lane (#2952, design `v6-cases.js` case 18).
 *
 * The lane `+` used to open `TaskFormModal` — a full form, over the board, to add one
 * row. Case 18's disposition table said **demote** it into the Designer, and that ruling
 * was amended: routing it through `?author=` would have dropped the lane's status default
 * silently, and that default is not incidental — the synthetic phase-less lane commits
 * `BACKLOG` as #387's VoC panel decided, and a real phase commits `NOT_STARTED`. Widening
 * the author param to carry board vocabulary would also have made a hand-editable URL into
 * a board write path.
 *
 * So the lane `+` is **promoted**, on the precedent the Inbox `Capture` set: a surface
 * doing a genuinely different job keeps its own affordance. Placing a card *in this cell*
 * is a different job from authoring a plan row. What goes is the competing **form**, which
 * is what case 18 was objecting to — not the entry point.
 *
 * It renders **in the cell the card will land in**, so the destination is answered by
 * looking rather than by remembering (#2957's rule that an affordance lands where its
 * position implies). The behavior is `useRapidCompose`, shared verbatim with the touch bar
 * so the two capture surfaces cannot drift.
 */
export function LaneComposeField({
  laneName,
  destinationLabel,
  onCommit,
  isPending = false,
  onClose,
}: LaneComposeFieldProps) {
  const compose = useRapidCompose({ onCommit, isPending, onClose });

  return (
    <div
      ref={compose.containerRef}
      className="mb-2 rounded-card border border-brand-primary/60 bg-neutral-surface-raised p-2"
      data-testid="lane-compose-field"
    >
      <form
        aria-label={`Add a task to ${laneName}`}
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
          placeholder="Name it, then press Enter"
          // The accessible name carries the destination because the visible hint
          // below is `aria-hidden` — stating it twice makes a lane of rows read as
          // twice as many facts (rule 309(b) / 328).
          aria-label={`Task name — lands in ${destinationLabel}, under ${laneName}`}
          aria-keyshortcuts="Enter Escape"
          className="min-w-0 flex-1 rounded-control border border-neutral-border bg-neutral-surface
            px-2 text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary
            focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary
            read-only:cursor-progress"
          style={{ height: 'var(--board-compose-input-height, 32px)' }}
        />
        <button
          type="submit"
          disabled={compose.submitDisabled}
          aria-busy={isPending}
          className="shrink-0 rounded-control bg-brand-primary px-3 text-xs font-semibold
            text-neutral-text-inverse focus:outline-none focus:ring-2 focus:ring-brand-primary
            focus:ring-offset-1 disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken
            disabled:text-neutral-text-secondary"
          style={{ height: 'var(--board-compose-input-height, 32px)' }}
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Stop adding to ${laneName}`}
          className="relative inline-flex shrink-0 items-center justify-center rounded-control
            text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none
            focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            before:absolute before:inset-[-8px] before:content-['']"
          style={{ width: 20, height: 20 }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </form>
      <p aria-hidden="true" className="pt-1 text-xs text-neutral-text-secondary">
        Lands in <span className="font-semibold text-neutral-text-primary">{destinationLabel}</span>
      </p>
    </div>
  );
}
