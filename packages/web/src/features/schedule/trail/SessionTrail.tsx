import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, UndoIcon } from '@/components/Icons';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { newestUndoableEntry, useTrailStore } from './trailStore';

/** Panel width, and the design cap on its height. Both are the hook's inputs. */
const TRAIL_WIDTH = 380;
const TRAIL_MAX_HEIGHT = 320;

/**
 * "N changes this session" — the record behind the outline's structural
 * gestures (#2948, epic #2946).
 *
 * Undo on this surface used to be a keystroke with nothing to inspect, which is
 * a lot of trust to ask for from gestures that move and delete whole subtrees.
 * This is the inspectable half: what happened, newest first, with the time.
 *
 * Since ADR-0880 (#2974) it is also a **control**, but only exactly as far as it can
 * honour: the six structural gestures the server records get an Undo, and the acts it
 * cannot reverse (duplicate, convert-to-milestone, single-row insert) render as a record
 * with no button. That asymmetry is the point — an Undo that silently did nothing would
 * be worse than the silence it replaced, because people rely on it.
 *
 * Only the newest reversible entry carries the control. `newestUndoableEntry` is the one
 * derivation both this popover and the ⌘Z binding read, so the button and the keystroke
 * always mean the same act.
 */
export interface SessionTrailProps {
  /** Reverses one entry. Omitted where the surface is read-only. */
  onUndo?: (entryId: number, operationId: string) => void;
  /** True while an undo is in flight, so the control cannot be double-fired. */
  undoPending?: boolean;
  /**
   * Drop the trigger's label, keeping the count and an undo glyph (#3076).
   *
   * The trail **compacts and never demotes into `···`**: it is the only
   * inspectable route to undo, and a record you must open a menu to discover
   * is not a record that the plan changed. At 62px the compact form is the
   * cheapest thing in the bar, which is why it survives to the narrowest
   * composition while commands around it move out.
   */
  compact?: boolean;
}

export function SessionTrail({
  onUndo,
  undoPending = false,
  compact = false,
}: SessionTrailProps = {}) {
  const entries = useTrailStore((s) => s.entries);
  const [open, setOpen] = useState(false);
  // Portal + clamp, per web rule 260. The panel USED to be an in-flow
  // `absolute right-0 w-[380px]`, which grows LEFTWARD from the trigger — and the
  // trail sits in the toolbar's left group, ~330px from the edge of ScheduleView's
  // `overflow-hidden` wrapper. The first ~50px of every line was painted nowhere,
  // and `toBeVisible()` passes on that box exactly as it did on the off-screen
  // one #2974 fixed (#3663). `align: 'right'` keeps the intended right-edge
  // alignment; the hook's clamp is what makes it safe at every rung of the fit
  // ladder, in both directions.
  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({
    open,
    width: TRAIL_WIDTH,
    estimatedHeight: TRAIL_MAX_HEIGHT,
    align: 'right',
    gap: 8,
  });

  // Portaling moved the panel out of the toolbar and onto the end of `<body>`, so
  // it is no longer the trigger's DOM neighbour and Tab from the trigger now walks
  // into the rest of the toolbar instead of into the record. Moving focus into the
  // dialog on open is what keeps its Close and Undo reachable — the same obligation
  // web rule 260 states for a portaled `role="menu"`, which a portaled dialog
  // inherits for the same reason. Escape and Close return it to the trigger below.
  // The panel carries the standard focus ring rather than bare `outline-none`: it is
  // programmatically focused, so without one a keyboard user is told nothing about
  // where focus landed.
  useEffect(() => {
    if (!open) return;
    popoverRef.current?.focus();
  }, [open, popoverRef]);

  // Escape closes and returns focus to the trigger — the same pattern the board
  // overflow menu and the card peek use.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (entries.length === 0) return null;

  const count = entries.length;
  const newestFirst = [...entries].reverse();
  const undoable = onUndo ? newestUndoableEntry(entries) : null;

  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        // The count is in the accessible name, not only the visible text — a
        // count-bearing button that announces just "changes" tells a screen
        // reader user nothing (ux-review §6.1).
        aria-label={`${count} structural ${count === 1 ? 'change' : 'changes'} this session. Review.`}
        // `shrink-0 whitespace-nowrap` matches every one of its toolbar peers
        // (`ScheduleModeChip`, `ScheduleSummaryChip`). Without
        // them this was the one flexible item in a `flex-nowrap` bar, so it
        // absorbed the whole overflow alone and its label wrapped inside a
        // 40px-tall strip — the visible artifact #3076 was filed for. It is
        // also what makes the bar's overflow *measurable*: a child that
        // squeezes hides the very condition the fit ladder reads.
        className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 h-7 px-2.5
          rounded-control border border-neutral-border
          bg-neutral-surface-raised text-xs font-medium text-neutral-text-secondary
          hover:text-neutral-text-primary hover:border-brand-primary
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        {/* The count is the part that cannot go: it is the whole signal that
            the plan moved. The label is the part that can. Both forms are
            `aria-hidden` because the button's own `aria-label` above already
            says it in words (rule 171). */}
        <span aria-hidden="true">{count}</span>
        {compact ? (
          <UndoIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">{count === 1 ? 'change' : 'changes'} this session</span>
        )}
      </button>

      {open &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            tabIndex={-1}
            aria-label="Structural changes this session"
            // The hook's `maxHeight` is the real gap to the viewport edge the panel
            // opened toward (rule 351). The 320px cap is a design decision about how
            // much record to show at once, so the panel takes whichever is tighter —
            // an inline style would otherwise silently beat a `max-h-` class.
            style={{
              ...popoverStyle,
              maxHeight: Math.min(
                TRAIL_MAX_HEIGHT,
                typeof popoverStyle.maxHeight === 'number'
                  ? popoverStyle.maxHeight
                  : TRAIL_MAX_HEIGHT,
              ),
            }}
            className="overflow-y-auto z-50 rounded-card border border-neutral-border
              bg-neutral-surface-raised shadow-popover
              focus:outline-none focus:ring-2 focus:ring-brand-primary"
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-border">
              <span className="text-xs font-semibold text-neutral-text-primary flex-1">
                This session
              </span>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                aria-label="Close"
                className="text-neutral-text-secondary hover:text-neutral-text-primary
                focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset rounded-control"
              >
                <CloseIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <ol className="py-1">
              {newestFirst.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2 px-3 py-1.5 text-xs">
                  <span className="tppm-mono text-neutral-text-secondary shrink-0 tabular-nums">
                    {entry.at.toTimeString().slice(0, 5)}
                  </span>
                  <span
                    className={
                      entry.undone
                        ? 'flex-1 text-neutral-text-secondary line-through'
                        : 'flex-1 text-neutral-text-primary'
                    }
                  >
                    {entry.text}
                  </span>
                  {undoable?.id === entry.id && entry.operationId && (
                    <button
                      type="button"
                      disabled={undoPending}
                      onClick={() => onUndo?.(entry.id, entry.operationId as string)}
                      // The accessible name carries the act, not just "Undo" — a row of
                      // identical "Undo" buttons tells a screen-reader user nothing about
                      // which one they are on (ux-review §6.1). Only one is ever rendered,
                      // but the name has to survive that changing.
                      aria-label={`Undo: ${entry.text}`}
                      className="shrink-0 h-6 px-2 rounded-control border border-neutral-border
                      text-xs font-medium text-neutral-text-secondary
                      hover:text-neutral-text-primary hover:border-brand-primary
                      disabled:opacity-50 disabled:cursor-not-allowed
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                    >
                      Undo
                    </button>
                  )}
                </li>
              ))}
            </ol>

            {/*
            Names the boundary rather than the capability. #2974 is explicit that
            advertising ⌘Z for an act that cannot be reversed is worse than advertising
            nothing, so this says which acts are outside it instead of implying they are
            inside.
          */}
            <p className="px-3 py-2 border-t border-neutral-border text-xs text-neutral-text-secondary">
              {onUndo
                ? 'Undo reverses moves, indents, grouping and reordering — one step at a time, newest first. Duplicating a row and turning one into a milestone cannot be undone; a deleted row offers Undo on its own confirmation.'
                : 'A record of what changed, not a way to reverse it — a deleted row offers Undo on its own confirmation for a few seconds.'}
            </p>
          </div>,
          document.body,
        )}
    </div>
  );
}
