import type { Task } from '@/types';

/**
 * Whether `task` is a **phase** — a rollup that must never be committed to a sprint.
 *
 * A phase is a non-subtask task that owns at least one *structural* (non-subtask)
 * child. Committing one to a sprint double-counts velocity (the child tasks already
 * carry the points), so the API rejects it unconditionally with the stable code
 * `phase_in_sprint_forbidden` (ADR-0293, superseding the ADR-0101 warn default).
 * The picker mirrors that server invariant by never offering a phase as a target.
 *
 * Reconciliation notes:
 * - This is *broader* than `task.isSummary` in one direction and *narrower* in
 *   another. `isSummary` (server: any direct WBS child) is true for both a phase
 *   **and** a leaf-with-subtasks summary. We deliberately exclude the latter: its
 *   children are drawer subtasks (`isSubtask === true`), a decomposition the team
 *   may legitimately commit (it stays a soft `summary_in_sprint` warning). Keying
 *   off *structural* children isolates the true phase-rollup case.
 * - It is broader than a WBS L1 root: a mid-tree summary that owns real children is
 *   a phase-rollup too, and is caught here (mirrors the API's `has_structural_child`).
 * - Sibling issue #1753 adds a first-class `isPhase` server field; until it lands we
 *   derive it client-side from the already-loaded task list.
 */
export function isPhaseTask(task: Task, allTasks: readonly Task[]): boolean {
  if (task.isSubtask === true) return false;
  return allTasks.some((t) => t.parentId === task.id && t.isSubtask !== true);
}
