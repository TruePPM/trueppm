/**
 * One `(task, date)` cell of the weekly timesheet grid (#1435, ADR-0224).
 *
 * Editable cells (0 or 1 backing entry) are a keyboard-fast input: type hours in any
 * shorthand, `Enter` (or blur) saves, `Esc` reverts. A cell backed by ≥2 entries is a
 * read-only sum (ADR-0224) — the grid never lets a single number silently overwrite
 * several entries; a subtle dot + tooltip points the contributor to My Work to edit them.
 */
import { useEffect, useRef, useState } from 'react';
import { formatMinutesAsHm, parseHoursToMinutes } from '@/lib/parseHours';

interface TimesheetCellProps {
  minutes: number;
  editable: boolean;
  entryCount: number;
  isWeekend: boolean;
  isToday: boolean;
  /** Announces day + task for screen readers (a11y — the grid builds it). */
  ariaLabel: string;
  /** Commit a new minute value for this cell (0 clears it). Only called for editable cells. */
  onSave: (minutes: number) => void;
}

const CELL_BASE =
  'relative h-9 w-full text-right tabular-nums text-sm outline-none transition-colors';

export function TimesheetCell({
  minutes,
  editable,
  entryCount,
  isWeekend,
  isToday,
  ariaLabel,
  onSave,
}: TimesheetCellProps) {
  const committed = minutes > 0 ? formatMinutesAsHm(minutes) : '';
  const [draft, setDraft] = useState(committed);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter / Esc blur the input to finish editing; this flag stops the blur handler from
  // committing a second time (Enter already committed; Esc must not save at all).
  const skipBlurCommit = useRef(false);

  // Keep the draft in sync with the committed value when the cell is not being edited
  // (e.g. an optimistic update or a refetch changed `minutes` under us).
  useEffect(() => {
    if (!focused) setDraft(committed);
  }, [committed, focused]);

  function commit() {
    const parsed = parseHoursToMinutes(draft);
    if (parsed === null) {
      // Unparseable — revert to the committed value, do not write.
      setDraft(committed);
      return;
    }
    if (parsed !== minutes) onSave(parsed);
  }

  const surface = isWeekend ? 'bg-neutral-surface-sunken' : isToday ? 'bg-brand-primary/5' : '';

  if (!editable) {
    // Read-only summed cell (≥2 entries) — ADR-0224.
    return (
      <div
        role="gridcell"
        aria-readonly="true"
        // Focusable so the "why can't I edit this" guidance in the aria-label is reachable
        // in a screen reader's focus mode (the grid navigates by Tab, not roving tabindex),
        // not only via the mouse-only title tooltip (web-rule).
        tabIndex={0}
        aria-label={`${ariaLabel}, ${formatMinutesAsHm(minutes)}, ${entryCount} entries — edit on My Work`}
        title={`${entryCount} entries · edit on My Work`}
        className={`${CELL_BASE} flex items-center justify-end gap-1 px-2 text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-primary ${surface}`}
      >
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-text-secondary"
        />
        {formatMinutesAsHm(minutes)}
      </div>
    );
  }

  return (
    <div role="gridcell" className={`${CELL_BASE} ${surface}`}>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        value={draft}
        placeholder="·"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          if (skipBlurCommit.current) {
            skipBlurCommit.current = false;
          } else {
            commit();
          }
          setFocused(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            skipBlurCommit.current = true; // Enter already saved — don't re-commit on blur.
            inputRef.current?.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(committed);
            skipBlurCommit.current = true; // Esc discards — never save.
            inputRef.current?.blur();
          }
        }}
        className="h-full w-full rounded-none border-0 bg-transparent px-2 text-right tabular-nums text-neutral-text-primary placeholder:text-neutral-text-disabled focus:bg-neutral-surface-raised focus:ring-2 focus:ring-inset focus:ring-brand-primary"
      />
    </div>
  );
}
