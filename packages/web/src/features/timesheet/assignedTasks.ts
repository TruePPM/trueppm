/**
 * The contributor's assigned tasks as timesheet row labels (#4766).
 *
 * The single mapping from the My Work payload (`GET /me/work/`, the same source the My
 * Work page renders) to the grid's row shape, shared by the page's row derivation and
 * the add-task picker so the two cannot drift on which tasks count as "assigned".
 */
import type { MyWorkPage, MyWorkTask } from '@/hooks/useMyWork';
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
 * Every loaded My Work task as row labels, in My Work order, de-duplicated (limit/offset
 * pagination can repeat a row across a page boundary) and excluding phases — the same
 * `!is_phase` filter My Work applies, since a phase is never a loggable assignment.
 */
export function assignedTaskMetas(pages: MyWorkPage[] | undefined): RowTaskMeta[] {
  const seen = new Set<string>();
  const out: RowTaskMeta[] = [];
  for (const t of (pages ?? []).flatMap((p) => p.results)) {
    if (t.is_phase || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(myWorkTaskMeta(t));
  }
  return out;
}
