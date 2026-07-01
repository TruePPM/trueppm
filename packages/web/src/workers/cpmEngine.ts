/**
 * Incremental CPM forward pass for the in-browser drag preview.
 *
 * Processes only the downstream subgraph of the dragged task — the server
 * owns the full-network CPM; this engine produces a fast local preview.
 *
 * Supports all four dependency types: FS, SS, FF, SF.
 *
 * Calendar fidelity (issue #1493): dates step on a fixed Mon–Fri working week
 * (see `isWorkingDay` below), matching the server's default calendar. Custom
 * calendars and `CalendarException` holidays are not modeled — the web client
 * has no access to that data at drag time (see ADR-0120) — so this is a
 * best-effort estimate, not the source of truth. The post-commit server CPM
 * run reconciles the authoritative dates. This mirrors the same fidelity
 * tradeoff already accepted for the resize-commit preview (issue #951).
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
  /**
   * Working-day duration (mirrors `Task.duration` server-side, which is
   * "duration in working days", not calendar days). Recomputing earlyFinish
   * from this on every shift — rather than reusing a fixed calendar-ms span —
   * is what makes the preview calendar-aware (issue #1493): a task's finish
   * date must re-skip weekends whenever its start moves into a new window.
   */
  durationDays: number;
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

// ---------------------------------------------------------------------------
// Calendar-aware date stepping (Mon–Fri fixed working week — see file header)
// ---------------------------------------------------------------------------

function isWorkingDay(ms: number): boolean {
  const dow = new Date(ms).getUTCDay(); // 0 = Sun … 6 = Sat
  return dow !== 0 && dow !== 6;
}

/** Return `ms` if it falls on a working day, otherwise the next working day. */
function nextWorkingDay(ms: number): number {
  let cur = ms;
  while (!isWorkingDay(cur)) cur += MS_PER_DAY;
  return cur;
}

/**
 * Step one day forward or backward from `ms` until landing on a working day.
 * Unlike {@link nextWorkingDay}, this always advances at least one day — the
 * primitive for walking off a known working day to the next one (duration
 * expansion), mirroring the server engine's `_scan_for_working_day`.
 */
function scanForWorkingDay(ms: number, forward: boolean): number {
  let cur = ms + (forward ? MS_PER_DAY : -MS_PER_DAY);
  while (!isWorkingDay(cur)) cur += forward ? MS_PER_DAY : -MS_PER_DAY;
  return cur;
}

/**
 * Last working day of a task given its start and working-day duration.
 * A duration of 0 is a milestone: returns the start day unchanged.
 * Mirrors the server engine's `_finish_from_start`.
 */
function finishFromStart(startMs: number, durationDays: number): number {
  if (durationDays <= 0) return startMs;
  let remaining = durationDays - 1;
  let cur = startMs;
  while (remaining > 0) {
    cur = scanForWorkingDay(cur, true);
    remaining -= 1;
  }
  return cur;
}

/**
 * First working day of a task given its finish and working-day duration.
 * Inverse of {@link finishFromStart} — used to translate an FF/SF
 * finish-side constraint back into an equivalent start-side constraint.
 * Mirrors the server engine's `_start_from_finish`.
 */
function startFromFinish(finishMs: number, durationDays: number): number {
  if (durationDays <= 0) return finishMs;
  let remaining = durationDays - 1;
  let cur = finishMs;
  while (remaining > 0) {
    cur = scanForWorkingDay(cur, false);
    remaining -= 1;
  }
  return cur;
}

/**
 * Advance `ms` by `lagDays` calendar days, then snap to the next working day.
 * Mirrors the server engine's `_advance_calendar_days`. `lagDays` may be
 * negative (a "lead").
 */
function advanceCalendarDays(ms: number, lagDays: number): number {
  return nextWorkingDay(ms + lagDays * MS_PER_DAY);
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
 *
 * Lag is applied as calendar days then snapped to a working day, and FF/SF
 * (finish-side) constraints are translated to an equivalent start-side value
 * via the target's own working-day duration — the same shape the server
 * engine's forward pass uses (issue #1493: lag was previously dropped
 * entirely and every step was calendar-blind).
 */
function constraintFromEdge(
  edge: CpmEdge,
  source: TaskState,
  target: TaskState,
): number {
  const lag = edge.lag;
  switch (edge.type) {
    case 'FS':
      // Target cannot start until the day after source finishes, plus lag,
      // snapped to the next working day.
      return nextWorkingDay(source.earlyFinishMs + MS_PER_DAY + lag * MS_PER_DAY);

    case 'SS':
      // Target cannot start before source starts + lag.
      return advanceCalendarDays(source.earlyStartMs, lag);

    case 'FF': {
      // Target cannot finish before source finishes + lag; translate that
      // finish-side constraint into the equivalent earlyStart.
      const efConstraint = advanceCalendarDays(source.earlyFinishMs, lag);
      return startFromFinish(efConstraint, target.durationDays);
    }

    case 'SF': {
      // Target cannot finish before source starts + lag; translate that
      // finish-side constraint into the equivalent earlyStart.
      const efConstraint = advanceCalendarDays(source.earlyStartMs, lag);
      return startFromFinish(efConstraint, target.durationDays);
    }
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
      // Working-day duration, not the calendar-ms span of the current dates
      // (see TaskState.durationDays doc — this is the calendar-blindness fix).
      durationDays: t.durationDays,
      isMilestone: t.isMilestone,
      name: t.name,
      baselineFinishMs: earlyFinishMs,
    });
  }

  // --- Override dragged task start ---
  const dragged = stateMap.get(draggedTaskId);
  if (dragged) {
    // Snap the drop target to a working day (mirrors the server's SNET
    // handling of planned_start), then recompute finish by walking the
    // task's working-day duration forward.
    const newStartMs = nextWorkingDay(toMs(newStartIso));
    dragged.earlyStartMs = newStartMs;
    dragged.earlyFinishMs = finishFromStart(newStartMs, dragged.durationDays);
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
      task.earlyFinishMs = finishFromStart(maxEarlyStart, task.durationDays);
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
    // Real float check (issue #1493): critical ⇔ total float (lateFinish -
    // earlyFinish) has hit zero or gone negative. `>=` (not `>`) so a task
    // that lands exactly on its late finish — the textbook zero-float
    // definition of "on the critical path" — is flagged, not just an overrun.
    const isCritical = task.earlyFinishMs >= task.lateFinishMs;

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
