/**
 * The contributor's assigned tasks as timesheet row labels (#4766).
 *
 * The single mapping from the My Work payload (`GET /me/work/`, the same source the My
 * Work page renders) to the grid's row shape, shared by the page's row derivation and
 * the add-task picker so the two cannot drift on which tasks count as "assigned".
 */
import type { MyWorkTask } from '@/hooks/useMyWork';
import type { RowTaskMeta } from './weekModel';

/** Row labels for one My Work task. */
export function myWorkTaskMeta(t: MyWorkTask): RowTaskMeta {
  return {
    taskId: t.id,
    taskShortId: t.short_id,
    taskName: t.name,
    projectId: t.project_id,
    // project_code is not on the /me/work payload; the row shows the project name, and the
    // code arrives with the first entry on the next weekly refetch.
    projectCode: '',
    projectName: t.project_name,
  };
}

/**
 * Every assigned task, in My Work order, de-duplicated (limit/offset pagination can repeat
 * a row across a page boundary) and excluding phases — the same `!is_phase` filter My Work
 * applies, since a phase is never a loggable assignment. These are the add-task picker's
 * candidates.
 */
export function assignedTasks(tasks: MyWorkTask[] | undefined): MyWorkTask[] {
  const seen = new Set<string>();
  const out: MyWorkTask[] = [];
  for (const t of tasks ?? []) {
    if (t.is_phase || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/**
 * The assigned tasks that get a zero row in the grid without an entry: those still open.
 *
 * Why status and not dates: a zero row says "you could be logging here". A COMPLETE task
 * is finished work, so it would only pad every week with rows nobody logs into; it shows
 * when it actually carries time that week (an entry row) and stays reachable from the
 * add-task picker. Open work is current in any week the contributor looks at, so it is
 * not filtered by date: `/me/work/` carries no schedule span — its one date, `due`, is an
 * end-ish cascade (ADR-0065) — and an open task due before the selected week is overdue
 * work still being done, not work outside the week. Undated open tasks are rows too, so
 * unscheduled work stays loggable.
 */
export function zeroRowCandidates(tasks: MyWorkTask[]): MyWorkTask[] {
  return tasks.filter((t) => t.status !== 'COMPLETE');
}
