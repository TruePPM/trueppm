import { useEffect, useRef, useState } from 'react';
import { CloseIcon } from '@/components/Icons';
import { useTrailStore } from './trailStore';

/**
 * "N changes this session" — the record behind the outline's structural
 * gestures (#2948, epic #2946).
 *
 * Undo on this surface used to be a keystroke with nothing to inspect, which is
 * a lot of trust to ask for from gestures that move and delete whole subtrees.
 * This is the inspectable half: what happened, newest first, with the time.
 *
 * It is deliberately a **record, not a control**. A general "undo the last
 * structural act" does not exist in this tree — the only undo paths are the
 * per-act ones (the delete toast's server restore, #2078, and the template-apply
 * undo). Putting an Undo button here that silently did nothing for indent or
 * move would be worse than the silence it replaces, so the trail states what it
 * is and points at the undo that does exist.
 */
export function SessionTrail() {
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
          className="absolute bottom-full right-0 mb-2 w-[380px] max-h-[320px] overflow-y-auto z-50
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
              <li key={entry.id} className="flex gap-2 px-3 py-1.5 text-xs">
                <span className="tppm-mono text-neutral-text-secondary shrink-0 tabular-nums">
                  {entry.at.toTimeString().slice(0, 5)}
                </span>
                <span className="text-neutral-text-primary">{entry.text}</span>
              </li>
            ))}
          </ol>

          <p className="px-3 py-2 border-t border-neutral-border text-xs text-neutral-text-secondary">
            A record of what changed, not a way to reverse it — a deleted row offers Undo on
            its own confirmation for a few seconds.
          </p>
        </div>
      )}
    </div>
  );
}
