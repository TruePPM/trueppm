import type { Task } from '@/types';

/**
 * Whether the Start date on display was produced by CPM rather than committed by
 * the PM (#3063).
 *
 * This is a property of the **value**, not of the task's workflow state: if
 * `planned_start` is null, then whatever `task.start` shows came from the
 * scheduler and will move when a predecessor does — and that is equally true of
 * a NOT_STARTED task and an IN_PROGRESS one. It is therefore the correct gate
 * for the computed-vs-committed *cue*, and it deliberately matches the gate the
 * canvas renderer and the Unscheduled gutter already use (`!plannedStart`, see
 * `GanttRenderer.drawTaskBar` and `useUnscheduledTasks`) so those three surfaces
 * cannot disagree about what "uncommitted" means.
 *
 * That divergence was the bug: the cue used to hang off
 * {@link isMissingCommittedStart}, whose extra status condition excludes
 * NOT_STARTED — the one status that reliably populates the Unscheduled gutter.
 * So the single case with no bar on the timeline was also the single case that
 * rendered its CPM date as a plain, committed-looking value with nothing
 * explaining the blank row.
 *
 * `task.start` must be non-empty: with no computed date there is no value to
 * qualify, and `StripFrame` renders an em dash instead.
 */
export function isStartComputed(task: Task): boolean {
  return !task.plannedStart && !task.isSummary && Boolean(task.start);
}

/**
 * The "no committed start" data-integrity flag (#317, ADR-0603): a task that has
 * reached IN_PROGRESS / REVIEW / COMPLETE without a PM-committed `plannedStart`.
 *
 * Narrower than {@link isStartComputed} on purpose, and the narrowness is the
 * point: this is the *defect* predicate — work reported as underway against
 * dates nobody committed — which is why it earns the amber treatment and the
 * "Move to To Do" demotion. An uncommitted NOT_STARTED task is not a defect, it
 * is simply unscheduled, so it must not be flagged as one (#3063).
 *
 * Check `plannedStart`, NOT `start` — CPM auto-fills `early_start` (`task.start`)
 * for every task, so `start` is rarely empty and gating on it would never fire.
 * Summaries are WBS rollups whose dates come from their children rather than a
 * committed start, so they are excluded.
 *
 * Single source of truth shared by the Schedule row chip (`MissingCommittedStartChip`,
 * #2313) and the task-drawer advisory (`TaskScheduleStrip`, #2314) so the two
 * surfaces that flag — and offer to fix — the same condition can never drift.
 */
export function isMissingCommittedStart(task: Task): boolean {
  return (
    !task.plannedStart &&
    !task.isSummary &&
    (task.status === 'IN_PROGRESS' || task.status === 'REVIEW' || task.status === 'COMPLETE')
  );
}
