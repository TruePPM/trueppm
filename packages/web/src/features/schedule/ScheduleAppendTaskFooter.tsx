import { useRowHeight } from '@/hooks/useRowHeight';

export interface ScheduleAppendTaskFooterProps {
  /** Appends a task at the end of the outline, at the top level. */
  onAppend: () => void;
  /**
   * True for an editor who pressed ⌥A and chose Read: the control stays
   * PRESENT and inert, because one key gets them back (web rule 302). A reader
   * with no rights never gets here at all — `TaskListPanel` is passed no
   * `onAppendTaskAtEnd`, so the whole row is absent.
   */
  readOnly?: boolean;
  /** 1-based treegrid row index — the row after the last task. */
  ariaRowIndex: number;
}

/**
 * The append-at-the-end affordance (#2957), rendered as the last row of the
 * outline.
 *
 * It sits at the foot of the plan and appends at the foot of the plan. That
 * sounds trivial and is the entire point: the control this replaces sat here
 * and did the *cursor's* bidding, inserting after whatever row happened to be
 * selected — a button whose position implies one thing and whose behavior does
 * another, which users read as a bug and filed as one.
 *
 * `aria-level={1}` is not decoration either: it states the depth the new row
 * lands at. The toolbar's insert takes the focused row's depth and the row-edge
 * `+` takes its own row's depth; this one is always top level, because the end
 * of the plan is not inside anything.
 *
 * Height comes from `useRowHeight()`, not the `ROW_HEIGHT` live binding (#2952).
 * Reading the binding inside a render returns the right number *once* and then
 * never re-renders when the pointer class flips — a tablet gaining a keyboard
 * left this row 44px tall in a 28px outline, which is precisely the "second
 * implementation that drifts" the one-place-to-author package exists to close.
 */
export function ScheduleAppendTaskFooter({
  onAppend,
  readOnly = false,
  ariaRowIndex,
}: ScheduleAppendTaskFooterProps) {
  const rowHeight = useRowHeight();
  return (
    <div
      role="row"
      aria-rowindex={ariaRowIndex}
      aria-level={1}
      data-testid="schedule-append-task-footer"
      className="flex items-center border-t border-dashed border-neutral-border"
      style={{ height: rowHeight }}
    >
      <div role="gridcell" className="flex-1 min-w-0 h-full flex items-center px-1">
        <button
          type="button"
          // Wrapped rather than passed straight through: `onAppend` takes no
          // arguments on purpose — there is no row id to pass, because nothing
          // about the cursor changes where this lands.
          onClick={() => onAppend()}
          disabled={readOnly}
          title={readOnly ? 'Read-only access' : undefined}
          // Full width and full row height. On a fine pointer the row is 28px,
          // so the 44px touch floor (rule 5) is unreachable inside it — taking
          // the whole row is the largest target the surface can offer, and it
          // matches how the rest of the outline treats a row as one target. On a
          // coarse pointer `useRowHeight()` is already 44px (#2997), so the same
          // "whole row" rule clears the floor rather than approximating it.
          className="flex items-center gap-1.5 w-full h-full px-2 rounded-control
            text-xs text-left text-neutral-text-secondary
            hover:text-brand-primary hover:bg-neutral-surface-sunken
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface
            disabled:text-neutral-text-disabled disabled:hover:bg-transparent
            disabled:cursor-not-allowed"
        >
          <span aria-hidden="true">+</span>
          Add an item at the end
        </button>
      </div>
    </div>
  );
}
