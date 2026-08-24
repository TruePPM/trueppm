import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRowHeight } from '@/hooks/useRowHeight';

export interface BlankOutlineDraftRowProps {
  /**
   * Commit a typed name as a real task. Called on Enter, and on blur when the
   * field has content. Omitted for read-only roles, which get a static line
   * instead of an input — a caret in a field that cannot save is a worse lie
   * than no caret at all.
   *
   * `opts.onError` is the same contract the backlog rail's quick capture uses
   * (#2030): this field clears optimistically so a second row can be typed
   * immediately, so a failed POST would otherwise lose the typed name with no
   * trace on the one screen where it is the user's *only* row (#2952).
   */
  onCommit?: (name: string, opts?: { onError?: () => void }) => void;
  /** Column width for the name cell, so the draft lines up with real rows. */
  nameWidth: number;
  /**
   * Everything a real row reserves left of its first column — the ⋮⋮ grip's
   * lane (#2997) plus the ⇤/⇥ structural-nudge lane (#3026) — from
   * `TaskListPanel`, via `resolveOutlineLeftReserve`. Defaults to 0 so the
   * *empty* variant — the "No items yet." line a viewer sees — reserves
   * nothing, matching the rows a viewer gets.
   */
  leftReserve?: number;
}

/**
 * Row 1 of a blank project's outline — live, with the caret already in it (#2733).
 *
 * This replaces the "No items yet ◆ ◆ ◆ / Add first item" card. The difference is
 * not cosmetic: a card is a thing you must *dismiss* before you can work, and it
 * made a brand-new project read as a failure state. A live row makes the same
 * screen a canvas — structure accumulates as you type, and the first keystroke is
 * the first task rather than the third click.
 *
 * It is a **local draft**, not an eagerly-created task. Creating a "New task" row
 * server-side on mere navigation would litter every project someone opened and
 * backed out of, and would put a row into other people's live views before its
 * author had typed anything. Nothing is persisted until there is a name to persist.
 */
export function BlankOutlineDraftRow({
  onCommit,
  nameWidth,
  leftReserve = 0,
}: BlankOutlineDraftRowProps) {
  const rowHeight = useRowHeight();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  // Guards the blur handler against double-committing what Enter just sent:
  // committing clears the field and re-focuses it, and the intervening blur would
  // otherwise fire a second create with the stale value.
  const committingRef = useRef(false);

  useEffect(() => {
    if (onCommit) inputRef.current?.focus();
  }, [onCommit]);

  function commit(next: string) {
    const name = next.trim();
    if (!name || !onCommit) return;
    committingRef.current = true;
    // Clear BEFORE handing the name off, so a caller that fails synchronously
    // still leaves the restored text in the field rather than having it wiped
    // by this line a moment later.
    setValue('');
    // Keep the caret here so a second row can be typed straight away —
    // "structure accumulates as you type" only works if Enter does not eject you.
    inputRef.current?.focus();
    onCommit(name, {
      // Restore only into a field the user has not already started refilling —
      // clobbering a half-typed second row to hand back the first one is worse
      // than the loss it repairs.
      onError: () => setValue((cur) => (cur === '' ? name : cur)),
    });
    committingRef.current = false;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(value);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setValue('');
    }
  }

  if (!onCommit) {
    return (
      <div
        role="row"
        aria-rowindex={2}
        aria-level={1}
        style={{ height: rowHeight }}
        className="flex items-center px-2 text-xs text-neutral-text-secondary"
      >
        <span role="gridcell">No items yet.</span>
      </div>
    );
  }

  return (
    <div
      role="row"
      aria-rowindex={2}
      // Same key set the outline's own rows carry (#2952). A `role="row"` inside
      // a `role="treegrid"` with no `aria-level` is an invalid tree node, and on
      // a blank project this row is the ONLY row — so the one screen where the
      // outline had nothing to announce was also the one where it announced it
      // wrongly. `1` because a first task is top level; there is nothing above
      // it to nest under.
      aria-level={1}
      style={{ height: rowHeight }}
      className="flex items-center border-b border-neutral-border/60"
    >
      {leftReserve > 0 && (
        <span aria-hidden="true" className="shrink-0" style={{ width: leftReserve }} />
      )}
      <div role="gridcell" style={{ width: nameWidth }} className="px-2">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (!committingRef.current) commit(value);
          }}
          // The placeholder carries the affordance the deleted card used to
          // spell out. It has to read as an invitation to type, not as a label
          // for a field someone is hunting for.
          placeholder="Type your first item, then press Enter"
          aria-label="First item name"
          className="w-full bg-transparent text-sm text-neutral-text-primary
            placeholder:text-neutral-text-disabled focus:outline-none"
        />
      </div>
    </div>
  );
}
