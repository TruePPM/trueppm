import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRowHeight } from '@/hooks/useRowHeight';

export interface BlankOutlineDraftRowProps {
  /**
   * Commit a typed name as a real task. Called on Enter, and on blur when the
   * field has content. Omitted for read-only roles, which get a static line
   * instead of an input — a caret in a field that cannot save is a worse lie
   * than no caret at all.
   */
  onCommit?: (name: string) => void;
  /** Column width for the name cell, so the draft lines up with real rows. */
  nameWidth: number;
  /**
   * Width of the ⋮⋮ grip's lane (#2997), from `TaskListPanel`. Defaults to 0 so
   * the *empty* variant — the "No tasks yet." line a viewer sees — reserves
   * nothing, matching the rows a viewer gets.
   */
  gripReserve?: number;
}

/**
 * Row 1 of a blank project's outline — live, with the caret already in it (#2733).
 *
 * This replaces the "No tasks yet ◆ ◆ ◆ / Add first task" card. The difference is
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
  gripReserve = 0,
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
    onCommit(name);
    setValue('');
    // Keep the caret here so a second row can be typed straight away —
    // "structure accumulates as you type" only works if Enter does not eject you.
    inputRef.current?.focus();
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
        style={{ height: rowHeight }}
        className="flex items-center px-2 text-xs text-neutral-text-secondary"
      >
        <span role="gridcell">No tasks yet.</span>
      </div>
    );
  }

  return (
    <div
      role="row"
      aria-rowindex={2}
      style={{ height: rowHeight }}
      className="flex items-center border-b border-neutral-border/60"
    >
      {gripReserve > 0 && (
        <span aria-hidden="true" className="shrink-0" style={{ width: gripReserve }} />
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
          placeholder="Type your first task, then press Enter"
          aria-label="First task name"
          className="w-full bg-transparent text-sm text-neutral-text-primary
            placeholder:text-neutral-text-disabled focus:outline-none"
        />
      </div>
    </div>
  );
}
