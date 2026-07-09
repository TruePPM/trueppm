import type { Task } from '@/types';

/**
 * Is this task a "phase" — ADR-0293 / epic #1752: a non-subtask task with at
 * least one structural (non-subtask) child. Distinct from `isSummary` (which
 * is true for ANY task with a child, including a leaf task that only has
 * drawer-added subtasks — ADR-0060 #308) and from a "leaf-with-subtasks"
 * (isSummary but NOT a phase).
 *
 * The backend (#1753) computes `is_phase` server-side and serializes it
 * read-only, mirroring `is_summary`. This helper prefers that server value
 * when present and falls back to the client-side structural-child predicate
 * so the frontend (#1754) works correctly whether or not #1753 has shipped
 * yet on a given deployment — a payload from a server that hasn't deployed
 * #1753 simply omits `isPhase`, and this derives the same answer from the
 * already-loaded task list.
 */
export function isPhaseTask(task: Task, allTasks: readonly Task[]): boolean {
  if (typeof task.isPhase === 'boolean') return task.isPhase;
  // A subtask (depth-1, ADR-0060) can never itself be a phase.
  if (task.isSubtask) return false;
  return allTasks.some((t) => t.parentId === task.id && t.isSubtask !== true);
}
