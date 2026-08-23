import { useEffect, useRef, useState } from 'react';
import { CloseIcon } from '@/components/Icons';
import { newestUndoableEntry, useTrailStore } from './trailStore';

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
}

export function SessionTrail({ onUndo, undoPending = false }: SessionTrailProps = {}) {
  const entries = useTrailStore((s) => s.entries);
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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
    <div className="relative">
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
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-control border border-neutral-border
          bg-neutral-surface-raised text-xs font-medium text-neutral-text-secondary
          hover:text-neutral-text-primary hover:border-brand-primary
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        {count} {count === 1 ? 'change' : 'changes'} this session
      </button>

      {open && (
        <div
          ref={popRef}
          role="dialog"
          aria-label="Structural changes this session"
          // Opens DOWNWARD. `bottom-full` assumes the trigger sits near the bottom of
          // the viewport; this one lives in the Schedule toolbar at y≈74, so the
          // popover rendered at y≈-126 — entirely off-screen. That was survivable
          // while the panel was a record with nothing to click, and is not now that
          // it carries the Undo control: the button was visible to `toBeVisible`,
          // outside the viewport, and unclickable (#2974).
          className="absolute top-full right-0 mt-2 w-[380px] max-h-[320px] overflow-y-auto z-50
            rounded-card border border-neutral-border bg-neutral-surface-raised shadow-popover"
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
        </div>
      )}
    </div>
  );
}
