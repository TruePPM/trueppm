/**
 * The contributor's assigned tasks as timesheet row labels (#4766).
 *
 * The single mapping from the My Work payload (`GET /me/work/`, the same source the My
 * Work page renders) to the grid's row shape, shared by the page's row derivation and
 * the add-task picker so the two cannot drift on which tasks count as "assigned".
 */
import type { MyWorkTask } from '@/hooks/useMyWork';
import { addDaysIso, type RowTaskMeta } from './weekModel';

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
 * The assigned tasks that get a zero row in the week starting `monday`, without an entry:
 * open tasks whose schedule span (ADR-0752 `scheduled_start`..`scheduled_finish`, #4783)
 * overlaps that week.
 *
 * - **COMPLETE** never gets a zero row: it is finished work and would only pad the grid.
 *   The read already asks the server for open work only; this is the client half of the
 *   same rule, so a payload that still carries one cannot pad the grid either.
 * - **Overdue open work stays current until it is done.** A span that ended before `today`
 *   is treated as running through `today`, so a late task is a row in the current week
 *   (and every week since it was due) — it is still being worked — but not in future weeks.
 * - **Undated** (no span at all, or a payload predating #4783) is a row in every week, so
 *   unscheduled work stays loggable. A span with only one end is open on the other side.
 *
 * Dates are ISO `YYYY-MM-DD` strings, which order lexicographically.
 */
export function zeroRowCandidates(
  tasks: MyWorkTask[],
  monday: string,
  today: string,
): MyWorkTask[] {
  const sunday = addDaysIso(monday, 6);
  return tasks.filter((t) => {
    if (t.status === 'COMPLETE') return false;
    const start = t.scheduled_start ?? null;
    const finish = t.scheduled_finish ?? null;
    if (start === null && finish === null) return true;
    const effectiveFinish = finish === null ? null : finish < today ? today : finish;
    return (
      (start === null || start <= sunday) && (effectiveFinish === null || effectiveFinish >= monday)
    );
  });
}
