/**
 * Incremental CPM forward pass for the in-browser drag preview.
 *
 * Processes only the downstream subgraph of the dragged task — the server
 * owns the full-network CPM; this engine produces a fast local preview.
 *
 * Supports all four dependency types: FS, SS, FF, SF.
 * All dates are calendar days (no working-calendar awareness) — matching
 * the server's simplified CPM for the preview use case.
 */

import type {
  CpmEdge,
  CpmTask,
  PreviewMilestone,
  PreviewTaskResult,
} from './cpmWorker.types';

/**
 * Internal mutable task state during the forward pass.
 * earlyStart/earlyFinish are calendar-day offsets from the epoch
 * (milliseconds) for arithmetic; converted back to ISO strings at the end.
 */
interface TaskState {
  id: string;
  earlyStartMs: number;
  earlyFinishMs: number;
  /** lateFinish from the last server CPM, in ms — for critical-path detection. */
  lateFinishMs: number;
  durationMs: number;
  isMilestone: boolean;
  name: string;
  /** Original earlyFinish before this recalc (baseline for deltaDays). */
  baselineFinishMs: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Build an adjacency list (predecessors per task) and in-degree map
 * for topological sort.
 */
function buildGraph(
  tasks: CpmTask[],
  edges: CpmEdge[],
): {
  predecessors: Map<string, CpmEdge[]>;
  inDegree: Map<string, number>;
} {
  const predecessors = new Map<string, CpmEdge[]>();
  const inDegree = new Map<string, number>();

  for (const t of tasks) {
    predecessors.set(t.id, []);
    inDegree.set(t.id, 0);
  }

  for (const edge of edges) {
    predecessors.get(edge.targetId)?.push(edge);
    inDegree.set(edge.targetId, (inDegree.get(edge.targetId) ?? 0) + 1);
  }

  return { predecessors, inDegree };
}

/**
 * Kahn's algorithm — returns tasks in topological order.
 * Cycles in the subgraph should not occur (server validates the schedule),
 * but if one is detected we process what we can and skip the remainder.
 */
function topologicalSort(
  tasks: CpmTask[],
  edges: CpmEdge[],
  inDegree: Map<string, number>,
): string[] {
  const successors = new Map<string, string[]>();
  for (const t of tasks) successors.set(t.id, []);
  for (const e of edges) successors.get(e.sourceId)?.push(e.targetId);

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  const remaining = new Map(inDegree);

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const succ of successors.get(id) ?? []) {
      const deg = (remaining.get(succ) ?? 1) - 1;
      remaining.set(succ, deg);
      if (deg === 0) queue.push(succ);
    }
  }

  return order;
}

/**
 * Compute the earliest possible earlyStart for a task given one predecessor edge.
 * Returns the minimum earlyStart implied by this edge (take the max across all edges).
 */
function constraintFromEdge(
  edge: CpmEdge,
  source: TaskState,
  target: TaskState,
): number {
  switch (edge.type) {
    case 'FS':
      // Target starts after source finishes.
      return source.earlyFinishMs + MS_PER_DAY;

    case 'SS':
      // Target starts no earlier than source starts.
      return source.earlyStartMs;

    case 'FF':
      // Target finishes no earlier than source finishes →
      // earlyStart = source.earlyFinish - target.duration + 1 day
      return source.earlyFinishMs - target.durationMs + MS_PER_DAY;

    case 'SF':
      // Target finishes no earlier than source starts →
      // earlyStart = source.earlyStart - target.duration + 1 day
      return source.earlyStartMs - target.durationMs + MS_PER_DAY;
  }
}

/**
 * Run the incremental CPM forward pass over the subgraph.
 *
 * The dragged task's earlyStart is overridden with `newStartIso`; all
 * downstream tasks are recalculated in topological order.
 *
 * Returns per-task results and the most-impacted milestone.
 */
export function runCpmForwardPass(
  tasks: CpmTask[],
  edges: CpmEdge[],
  draggedTaskId: string,
  newStartIso: string,
): {
  results: PreviewTaskResult[];
  worstMilestone: PreviewMilestone | null;
} {
  // --- Build state map ---
  const stateMap = new Map<string, TaskState>();
  for (const t of tasks) {
    const earlyStartMs = toMs(t.earlyStart);
    const earlyFinishMs = toMs(t.earlyFinish);
    stateMap.set(t.id, {
      id: t.id,
      earlyStartMs,
      earlyFinishMs,
      lateFinishMs: toMs(t.lateFinish),
      // Duration in ms = finish - start + 1 day (inclusive)
      durationMs: earlyFinishMs - earlyStartMs + MS_PER_DAY,
      isMilestone: t.isMilestone,
      name: t.name,
      baselineFinishMs: earlyFinishMs,
    });
  }

  // --- Override dragged task start ---
  const dragged = stateMap.get(draggedTaskId);
  if (dragged) {
    const newStartMs = toMs(newStartIso);
    dragged.earlyStartMs = newStartMs;
    dragged.earlyFinishMs = newStartMs + dragged.durationMs - MS_PER_DAY;
  }

  // --- Topological sort ---
  const { predecessors, inDegree } = buildGraph(tasks, edges);
  const order = topologicalSort(tasks, edges, inDegree);

  // --- Forward pass ---
  for (const taskId of order) {
    if (taskId === draggedTaskId) continue; // Already set above.
    const task = stateMap.get(taskId);
    if (!task) continue;

    const preds = predecessors.get(taskId) ?? [];
    if (preds.length === 0) continue; // No predecessors — keep original dates.

    let maxEarlyStart = -Infinity;
    for (const edge of preds) {
      const source = stateMap.get(edge.sourceId);
      if (!source) continue;
      const constraint = constraintFromEdge(edge, source, task);
      if (constraint > maxEarlyStart) maxEarlyStart = constraint;
    }

    if (maxEarlyStart > task.earlyStartMs) {
      task.earlyStartMs = maxEarlyStart;
      task.earlyFinishMs = maxEarlyStart + task.durationMs - MS_PER_DAY;
    }
  }

  // --- Collect results ---
  const results: PreviewTaskResult[] = [];
  let worstMilestone: PreviewMilestone | null = null;
  let worstDelta = 0;

  for (const task of stateMap.values()) {
    const deltaDays = Math.round(
      (task.earlyFinishMs - task.baselineFinishMs) / MS_PER_DAY,
    );
    const isCritical = task.earlyFinishMs > task.lateFinishMs;

    results.push({
      taskId: task.id,
      earlyStart: toIso(task.earlyStartMs),
      earlyFinish: toIso(task.earlyFinishMs),
      isCritical,
      deltaDays,
    });

    if (task.isMilestone && deltaDays > worstDelta) {
      worstDelta = deltaDays;
      worstMilestone = {
        taskId: task.id,
        name: task.name,
        baselineFinish: toIso(task.baselineFinishMs),
        newFinish: toIso(task.earlyFinishMs),
        deltaDays,
      };
    }
  }

  return { results, worstMilestone };
}
