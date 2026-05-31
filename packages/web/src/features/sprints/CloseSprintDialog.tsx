import { useEffect, useState } from 'react';
import type { ApiSprint } from '@/types';
import type { SprintBacklogTask } from '@/hooks/useSprintBacklog';
import { sprintDayOf } from './sprintMath';

export type CarryOverChoice = 'next' | 'backlog' | 'none';

/** Disposition for pending scope-changes at close (ADR-0102 §7). */
export type PendingDisposition = 'carry' | 'reject';

interface Props {
  sprint: ApiSprint;
  /** The next planned sprint, when one exists — preselects "next" carry-over. */
  nextPlannedSprintId: string | null;
  nextPlannedSprintName: string | null;
  /** Backlog rows for the active sprint — drives the "remaining" stat. */
  backlogTasks: SprintBacklogTask[];
  isClosing: boolean;
  onCancel: () => void;
  /**
   * Close confirmed. `pendingDisposition` is supplied only when the sprint had
   * pending scope changes (ADR-0102 §7) — `'carry'` (default) or `'reject'`.
   * Close is NEVER blocked by pending items; this advisory just lets the team
   * choose what happens to them. */
  onConfirm: (carryOverTo: string, pendingDisposition?: PendingDisposition) => void;
}

/**
 * Confirmation dialog for closing the active sprint (issue #299).
 *
 * Replaces the old "Close sprint" button's direct mutation call. Surfaces
 * sprint context (day-N-of-M, remaining work) and lets the user choose a
 * carry-over destination for incomplete work. The backend close endpoint
 * accepts either the literal `'backlog'`, `'none'`, or a sprint id; this
 * dialog maps the radio choice to those values before calling onConfirm.
 */
export function CloseSprintDialog({
  sprint,
  nextPlannedSprintId,
  nextPlannedSprintName,
  backlogTasks,
  isClosing,
  onCancel,
  onConfirm,
}: Props) {
  const defaultChoice: CarryOverChoice = nextPlannedSprintId ? 'next' : 'backlog';
  const [choice, setChoice] = useState<CarryOverChoice>(defaultChoice);
  // Pending-scope disposition (ADR-0102 §7). Defaults to carry-over — never
  // auto-discards, never blocks the close.
  const pendingCount = sprint.pending_count ?? 0;
  const [pendingDisposition, setPendingDisposition] =
    useState<PendingDisposition>('carry');

  // Esc to cancel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isClosing) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, isClosing]);

  const { day, total } = sprintDayOf(sprint.start_date, sprint.finish_date);
  const remainingTasks = backlogTasks.filter((t) => t.status !== 'COMPLETE');
  const remainingPoints = remainingTasks.reduce(
    (sum, t) => sum + (t.story_points ?? 0),
    0,
  );

  function handleConfirm() {
    const carryOverTo =
      choice === 'next' && nextPlannedSprintId ? nextPlannedSprintId : choice;
    onConfirm(carryOverTo, pendingCount > 0 ? pendingDisposition : undefined);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="close-sprint-title"
      className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-neutral-text-primary/40"
    >
      <div className="w-[440px] max-w-full rounded-md border border-neutral-border bg-neutral-surface flex flex-col gap-4 p-5">
        <h2
          id="close-sprint-title"
          className="text-base font-semibold text-neutral-text-primary"
        >
          Close <span className="italic">{sprint.name}</span>?
        </h2>

        <p className="text-xs text-neutral-text-secondary">
          <span className="tppm-mono">Day {day} of {total}</span>
          {' · '}
          <span className="tppm-mono">{remainingTasks.length}</span> task
          {remainingTasks.length === 1 ? '' : 's'}
          {remainingPoints > 0 && (
            <>
              {' ('}
              <span className="tppm-mono">{remainingPoints}</span> pt
              {remainingPoints === 1 ? '' : 's'}
              {') '}
            </>
          )}
          {' '}remaining.
        </p>

        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-1">
            Carry over incomplete work to
          </legend>
          {nextPlannedSprintId && (
            <label htmlFor="close-sprint-carryover-next" className="flex items-start gap-2 cursor-pointer">
              <input
                id="close-sprint-carryover-next"
                type="radio"
                name="close-sprint-carryover"
                checked={choice === 'next'}
                onChange={() => setChoice('next')}
                className="mt-0.5 accent-brand-primary"
              />
              <span>
                <span className="font-medium">→ Next planned sprint</span>
                {nextPlannedSprintName && (
                  <span className="text-xs text-neutral-text-secondary">
                    {' '}({nextPlannedSprintName})
                  </span>
                )}
              </span>
            </label>
          )}
          <label htmlFor="close-sprint-carryover-backlog" className="flex items-start gap-2 cursor-pointer">
            <input
              id="close-sprint-carryover-backlog"
              aria-label="Project backlog"
              type="radio"
              name="close-sprint-carryover"
              checked={choice === 'backlog'}
              onChange={() => setChoice('backlog')}
              className="mt-0.5 accent-brand-primary"
            />
            <span>
              <span className="font-medium">→ Project backlog</span>
              <span className="block text-xs text-neutral-text-secondary">
                Tasks return to BACKLOG status; sprint membership clears.
              </span>
            </span>
          </label>
          <label htmlFor="close-sprint-carryover-none" className="flex items-start gap-2 cursor-pointer">
            <input
              id="close-sprint-carryover-none"
              aria-label="Leave on this sprint"
              type="radio"
              name="close-sprint-carryover"
              checked={choice === 'none'}
              onChange={() => setChoice('none')}
              className="mt-0.5 accent-brand-primary"
            />
            <span>
              <span className="font-medium">Leave on this sprint</span>
              <span className="block text-xs text-neutral-text-secondary">
                Preserves the sprint&apos;s history for retrospectives.
              </span>
            </span>
          </label>
        </fieldset>

        {/* Pending-scope advisory (ADR-0102 §7) — surfaced only when the sprint
            still has un-accepted injections. This NEVER blocks the close; it
            offers a disposition (carry over by default, or reject). role=status
            (not alert) — it is informational, consistent with warn-never-block. */}
        {pendingCount > 0 && (
          <fieldset
            role="status"
            className="flex flex-col gap-2 text-sm rounded-md border border-neutral-border bg-neutral-surface-sunken p-3"
          >
            <legend className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary px-1">
              <span aria-hidden="true">○</span>{' '}
              <span className="tppm-mono">{pendingCount}</span> item
              {pendingCount === 1 ? '' : 's'} pending acceptance
            </legend>
            <p className="text-xs text-neutral-text-secondary">
              These were added after the sprint started and were never counted in the
              commitment, so closing now keeps this sprint&apos;s velocity correct either way.
            </p>
            <label
              htmlFor="close-sprint-pending-carry"
              className="flex items-start gap-2 cursor-pointer"
            >
              <input
                id="close-sprint-pending-carry"
                aria-label="Carry them to the next sprint"
                type="radio"
                name="close-sprint-pending"
                checked={pendingDisposition === 'carry'}
                onChange={() => setPendingDisposition('carry')}
                className="mt-0.5 accent-brand-primary"
              />
              <span>
                <span className="font-medium">Carry them to the next sprint</span>
                <span className="block text-xs text-neutral-text-secondary">
                  They stay pending acceptance on the incoming sprint.
                </span>
              </span>
            </label>
            <label
              htmlFor="close-sprint-pending-reject"
              className="flex items-start gap-2 cursor-pointer"
            >
              <input
                id="close-sprint-pending-reject"
                aria-label="Reject them"
                type="radio"
                name="close-sprint-pending"
                checked={pendingDisposition === 'reject'}
                onChange={() => setPendingDisposition('reject')}
                className="mt-0.5 accent-brand-primary"
              />
              <span>
                <span className="font-medium">Reject them</span>
                <span className="block text-xs text-neutral-text-secondary">
                  They are removed from the sprint.
                </span>
              </span>
            </label>
          </fieldset>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-border">
          <button
            type="button"
            onClick={onCancel}
            disabled={isClosing}
            className="h-8 px-3 rounded text-xs font-medium border border-neutral-border
              text-neutral-text-primary hover:bg-neutral-surface-raised
              disabled:opacity-50 disabled:cursor-not-allowed
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isClosing}
            className="h-8 px-3 rounded text-xs font-medium border border-semantic-critical/40
              text-semantic-critical hover:bg-semantic-critical-bg
              disabled:opacity-50 disabled:cursor-not-allowed
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
          >
            {isClosing ? 'Closing…' : 'Close sprint'}
          </button>
        </div>
      </div>
    </div>
  );
}
