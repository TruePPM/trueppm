import { useEffect, useState } from 'react';
import type { ApiSprint } from '@/types';
import type { SprintBacklogTask } from '@/hooks/useSprintBacklog';
import { sprintDayOf } from './sprintMath';

export type CarryOverChoice = 'next' | 'backlog' | 'none';

interface Props {
  sprint: ApiSprint;
  /** The next planned sprint, when one exists — preselects "next" carry-over. */
  nextPlannedSprintId: string | null;
  nextPlannedSprintName: string | null;
  /** Backlog rows for the active sprint — drives the "remaining" stat. */
  backlogTasks: SprintBacklogTask[];
  isClosing: boolean;
  onCancel: () => void;
  onConfirm: (carryOverTo: string) => void;
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
    onConfirm(carryOverTo);
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
