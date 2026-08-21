import type { Task } from '@/types';

/**
 * Pure helpers for the gutter → outline selection bridge (#2987).
 *
 * React-free so the two things most likely to be wrong — which rows the tray
 * offers to schedule, and which ancestors have to be expanded before those rows
 * exist in `visibleTasks` — are unit testable without mounting the Schedule.
 */

/**
 * The unscheduled rows the tray may act on.
 *
 * Sprint-targeted rows are excluded. They are uncommitted work whose dates come
 * from sprint planning, and the tray already renders them read-only (the
 * `planned` variant carries no drag handle); offering them here and refusing
 * them later would put apparatus on a surface whose whole point is that it
 * offers none.
 *
 * This is a **presentation** rule, not a security control — the bulk endpoint
 * does not currently refuse these writes (#2984 owns that fix). Do not let this
 * filter stand in for the server-side guard.
 */
export function datableUnscheduledIds(unscheduledTasks: Task[]): string[] {
  return unscheduledTasks.filter((t) => !t.sprintId).map((t) => t.id);
}

/**
 * Every ancestor id of `targetIds`, walking `parentId` to the root.
 *
 * The selection the bulk sheet resolves against is `visibleTasks`, which is the
 * WBS tree flattened through `expandedIds` — so a target row sitting inside a
 * collapsed phase is *not* in `visibleTasks` and would silently resolve to
 * nothing. Selecting 18 rows and editing 4 is the failure this prevents.
 *
 * Cycle-guarded: a corrupt parent chain must not hang the click handler. A
 * self-parent or a loop terminates instead of spinning.
 */
export function ancestorIdsOf(allTasks: Task[], targetIds: string[]): string[] {
  const parentById = new Map<string, string | null>();
  for (const t of allTasks) parentById.set(t.id, t.parentId);

  const out = new Set<string>();
  for (const id of targetIds) {
    let cursor = parentById.get(id) ?? null;
    const seen = new Set<string>([id]);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      out.add(cursor);
      cursor = parentById.get(cursor) ?? null;
    }
  }
  return [...out];
}
