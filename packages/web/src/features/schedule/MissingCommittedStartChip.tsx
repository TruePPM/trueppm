import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { Button } from '@/components/Button';
import { WarningIcon } from '@/components/Icons';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import type { Task } from '@/types';

import { useCommitStartOrTodo } from './useCommitStartOrTodo';

/**
 * Point-of-fix affordance for the "no committed start" data-integrity flag
 * (#2313, ADR-0603). The amber chip on a Schedule task-list row is a real
 * `<button>` (not the old dead `<span>`) that opens a small anchored popover
 * naming the gap and offering the two remediations — Set committed start /
 * Move to To Do — so diagnosis and fix stay at the left edge (1 click + 1
 * click), never a cross-screen drawer round-trip.
 *
 * The popover is portaled via {@link useAnchoredPopover} (web-rule 260) because
 * the row lives inside the task list's `overflow-y-auto` scroll container, which
 * would otherwise clip it. Warning tone throughout (`semantic-at-risk` tokens) —
 * this is a genuine warning, not the neutral read-state of web-rule 149.
 *
 * Non-editors (`canEdit` false) see the explanation only, no action buttons
 * (web-rules 156/272): a false affordance that 403s is worse than none. The
 * mutations come from the shared {@link useCommitStartOrTodo} hook, reused by the
 * drawer advisory (#2315).
 */
export function MissingCommittedStartChip({
  task,
  projectId,
  canEdit,
}: {
  task: Task;
  projectId: string;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const popoverId = useId();

  const { commitStart, moveToTodo, error, clearError } = useCommitStartOrTodo(task, projectId);

  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({
    open,
    width: 306,
    // Sentence (~3 lines) + optional action row; a sound flip-above estimate.
    estimatedHeight: 150,
    align: 'right',
    gap: 6,
    onDismiss: () => setOpen(false),
  });

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  // Move focus into the dialog on open so keyboard / SR users land on the
  // content and can Tab to the actions; a fresh open starts with no error.
  useEffect(() => {
    if (!open) return;
    clearError();
    popoverRef.current?.focus();
  }, [open, popoverRef, clearError]);

  // Escape peels this popover only (capture-phase + stopPropagation), matching
  // the FieldHelp pattern (web-rule 260) so it never closes an ancestor.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeAndRestoreFocus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // closeAndRestoreFocus is stable (refs + setState only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The row is in an `overflow-y-auto` list; scrolling it should dismiss this
  // transient warning popover rather than let it trail the moving row.
  useEffect(() => {
    if (!open) return undefined;
    function onScroll() {
      setOpen(false);
    }
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  function runAction(action: () => void) {
    action();
    // Offline is the one synchronous failure (the hook sets `error`); keep the
    // popover open so that message is visible. An online write is optimistic and
    // clears the flag, so close immediately.
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    closeAndRestoreFocus();
  }

  const startLabel = task.start ? `Set committed start (${fmtUtcShort(task.start)})` : 'Set committed start';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // Keep the #2312 accessible name, testid, and visible text; the element
        // is now a button (aria-haspopup announces the dialog it opens).
        aria-label="No committed start date — dates shown are auto-calculated, not committed."
        title="In progress without a committed start. The dates shown are auto-calculated (CPM), not committed. Set a committed start, or move it back to To Do."
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        data-testid="missing-dates-chip"
        onClick={(e) => {
          // The row selects on click and opens the drawer on double-click;
          // opening this popover must do neither.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={`inline-flex shrink-0 items-center gap-0.5 rounded-chip border px-1 py-px text-xs font-medium text-semantic-at-risk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-at-risk focus-visible:ring-offset-1 ${
          open ? 'border-semantic-at-risk bg-semantic-at-risk-bg' : 'border-semantic-at-risk/40'
        }`}
      >
        <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
        <span>no committed start</span>
      </button>

      {open &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="dialog"
            aria-modal="false"
            aria-labelledby={headingId}
            tabIndex={-1}
            style={popoverStyle}
            className="z-50 flex flex-col gap-2 rounded-lg border border-semantic-at-risk bg-semantic-at-risk-bg p-3 shadow-pop focus-visible:outline-none motion-safe:animate-empty-state-in"
          >
            <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-semibold text-semantic-at-risk">
              <WarningIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              No committed start
            </h2>
            <p className="text-xs leading-relaxed text-neutral-text-primary">
              Start and Finish here are auto-calculated by the scheduler (CPM). This task has no
              committed start, so these dates will shift whenever a predecessor moves.
            </p>

            {error && (
              <p role="alert" className="text-xs font-medium text-semantic-critical">
                {error}
              </p>
            )}

            {canEdit && (
              <div className="flex flex-wrap gap-2 pt-0.5">
                <Button variant="primary" size="sm" onClick={() => runAction(commitStart)}>
                  {startLabel}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => runAction(moveToTodo)}>
                  Move to To Do
                </Button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
