/**
 * Extract the downstream subgraph reachable from a given task (inclusive).
 *
 * The CPM worker needs only the tasks and links that are affected by a drag —
 * upstream tasks are irrelevant to the forward pass. This keeps the worker
 * payload small for large schedules.
 */

import type { Task, TaskLink } from '@/types';
import type { CpmEdge, CpmTask } from '@/workers/cpmWorker.types';

/**
 * BFS from `startTaskId` following link edges in the forward direction
 * (sourceId → targetId). Returns the inclusive downstream subgraph as
 * CPM worker types.
 */
export function buildSubgraph(
  startTaskId: string,
  tasks: Task[],
  links: TaskLink[],
): { tasks: CpmTask[]; edges: CpmEdge[] } {
  // Index tasks by id for fast lookup
  const taskIndex = new Map<string, Task>();
  for (const t of tasks) taskIndex.set(t.id, t);

  // Build adjacency list: sourceId → outgoing links
  const outgoing = new Map<string, TaskLink[]>();
  for (const t of tasks) outgoing.set(t.id, []);
  for (const link of links) {
    outgoing.get(link.sourceId)?.push(link);
  }

  // BFS to collect reachable task ids
  const visited = new Set<string>();
  const queue: string[] = [startTaskId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const link of outgoing.get(id) ?? []) {
      if (!visited.has(link.targetId)) {
        queue.push(link.targetId);
      }
    }
  }

  // Collect edges that are internal to the subgraph
  const edges: CpmEdge[] = [];
  for (const link of links) {
    if (visited.has(link.sourceId) && visited.has(link.targetId)) {
      edges.push({
        sourceId: link.sourceId,
        targetId: link.targetId,
        type: link.type,
        lag: link.lag,
      });
    }
  }

  // Collect CpmTask shapes for visited tasks
  const cpmTasks: CpmTask[] = [];
  for (const id of visited) {
    const t = taskIndex.get(id);
    if (!t) continue;
    // lateFinish: the real CPM late_finish from the last server run (issue
    // #1493). `baselineFinish` is a *baseline plan snapshot* — a semantically
    // different field — and using it (or `finish`) as a late_finish stand-in
    // made the CP-flip badge mis-fire (any slip past the baseline/current
    // finish read as "critical" regardless of actual float). Falls back to
    // `finish` only when the server hasn't populated late_finish yet (e.g.
    // before the first CPM run) — a conservative "assume zero float" default
    // that never falsely announces a slip as critical from an unset field.
    const lateFinish = t.lateFinish ?? t.finish;
    cpmTasks.push({
      id: t.id,
      earlyStart: t.start,
      earlyFinish: t.finish,
      lateFinish,
      durationDays: t.duration,
      isMilestone: t.isMilestone,
      name: t.name,
    });
  }

  return { tasks: cpmTasks, edges };
}
