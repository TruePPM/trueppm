/**
 * Incremental CPM forward pass for the in-browser drag preview.
 *
 * Processes only the downstream subgraph of the dragged task — the server
 * owns the full-network CPM; this engine produces a fast local preview.
 *
 * Supports all four dependency types: FS, SS, FF, SF.
 *
 * Progress semantics (ADR-0132, issue #2813). The engine applies the same three
 * floors the two server engines do (`engine.py::_forward_pass` /
 * `wasm-scheduler/src/forward.rs`), because a preview that ignores them shows
 * dates the server contradicts on commit — bars visibly snap back once the CPM
 * run lands, which reads as data corruption rather than as reconciliation:
 *
 *  1. **Completed work is pinned.** A task that is complete AND carries a
 *     recorded actual (`actual_start` or `actual_finish`) is out of network
 *     logic entirely — it never moves, not even when it IS the drag target.
 *     Its finish still constrains its successors.
 *  2. **In-progress work contributes only what is left.** The forward pass lays
 *     `remainingDuration` — not the full duration — ahead of the successors,
 *     and floors the task's early start at its recorded `actual_start`.
 *  3. **The dragged task is floored at the data date.** A drop in the past
 *     resolves to `max(status_date, drop)` the way the server's armed data-date
 *     floor does. `statusDate` is the ALREADY-RESOLVED date — the caller does
 *     the `?? today` half of `resolve_cpm_status_date()` — so this stays a pure
 *     function of its inputs; omit it and no data-date floor is applied.
 *
 * Floor 3 is applied to the DRAGGED task only, deliberately. The other tasks in
 * the subgraph are only ever pushed forward from where the last server CPM run
 * left them, so their data-date floor is already satisfied; re-deriving it for
 * all of them would attribute a stale schedule's one-time catch-up shift
 * (ADR-0752 §7) to the user's drag and headline a milestone slip they did not
 * cause.
 *
 * The engine reasons in two vocabularies, and the distinction is load-bearing:
 * the **early window** (`early_start`/`early_finish`) is what the network
 * schedules with, while the **span** (`scheduled_start`..`early_finish`) is what
 * the bar paints (ADR-0752). They coincide for not-started and completed work
 * and diverge for in-progress work, so `PreviewTaskResult.earlyStart` carries
 * the span — mirroring `_compute_scheduled_start` — while the relaxation runs
 * on the early window.
 *
 * Calendar fidelity (issue #1493): dates step on a fixed Mon–Fri working week
 * (see `isWorkingDay` below), matching the server's default calendar. Custom
 * calendars and `CalendarException` holidays are not modeled — the web client
 * has no access to that data at drag time (see ADR-0120) — so this is a
 * best-effort estimate, not the source of truth. The post-commit server CPM
 * run reconciles the authoritative dates. This mirrors the same fidelity
 * tradeoff already accepted for the resize-commit preview (issue #951).
 *
 * Known remaining gaps, all reconciled by the server on commit:
 *  - the fixed Mon–Fri week above (#1493);
 *  - `planned_start` (SNET) is not carried, so a downstream task's own start
 *    constraint is not re-applied. Harmless while relaxation is forward-only —
 *    a task's current start already satisfies it — but it would matter if this
 *    pass ever learned to pull tasks earlier;
 *  - the project-start floor, which the pull-to-commit prompt (#868/#884)
 *    covers at commit time instead.
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
  /**
   * The REMAINING-WORK window start (the server's `early_start`). For an
   * in-progress task this is later than {@link spanStartMs}; for everything
   * else the two are the same date.
   */
  earlyStartMs: number;
  earlyFinishMs: number;
  /**
   * The SPAN start — where the bar's left edge paints (ADR-0752's
   * `scheduled_start`, raised by any `planned_start`). This is what the preview
   * reports, never `earlyStartMs`.
   */
  spanStartMs: number;
  /** lateFinish from the last server CPM, in ms — for critical-path detection. */
  lateFinishMs: number;
  /**
   * FULL working-day duration (mirrors `Task.duration` server-side, which is
   * "duration in working days", not calendar days). Recomputing earlyFinish
   * from this on every shift — rather than reusing a fixed calendar-ms span —
   * is what makes the preview calendar-aware (issue #1493): a task's finish
   * date must re-skip weekends whenever its start moves into a new window.
   */
  durationDays: number;
  /**
   * Working-day duration of the work that is LEFT (ADR-0132 §3). Equals
   * {@link durationDays} on a not-started task and on a pinned one (a completed
   * task keeps its full shape, ADR-0136); smaller on in-progress work, which is
   * what the forward pass lays ahead of the successors.
   */
  effectiveDurationDays: number;
  /**
   * True when recorded actuals take this task out of network logic
   * (`_pinned_placement`). A pinned task is never relaxed and never accepts a
   * drag, but its dates still feed its successors' constraints.
   */
  isPinned: boolean;
  /** Recorded `actual_start` in ms, or null — the in-progress ES floor. */
  actualStartMs: number | null;
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
 *
 * That translation walks the target's REMAINING duration (issue #2813), because
 * that is what the finish will be re-derived from; backing off the full duration
 * would hand an in-progress target a start early enough for work it has already
 * done, exactly as `apply_ef_constraints` avoids server-side.
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
      return startFromFinish(efConstraint, target.effectiveDurationDays);
    }

    case 'SF': {
      // Target cannot finish before source starts + lag; translate that
      // finish-side constraint into the equivalent earlyStart.
      const efConstraint = advanceCalendarDays(source.earlyStartMs, lag);
      return startFromFinish(efConstraint, target.effectiveDurationDays);
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
  statusDate?: string | null,
): {
  results: PreviewTaskResult[];
  worstMilestone: PreviewMilestone | null;
} {
  // --- Build state map ---
  const stateMap = new Map<string, TaskState>();
  for (const t of tasks) stateMap.set(t.id, toTaskState(t));

  // --- Override dragged task start ---
  applyDrag(stateMap.get(draggedTaskId), newStartIso, statusDate);

  // --- Topological sort ---
  const { predecessors, inDegree } = buildGraph(tasks, edges);
  const order = topologicalSort(tasks, edges, inDegree);

  // --- Forward pass ---
  relaxForward(order, stateMap, predecessors, draggedTaskId);

  // --- Collect results ---
  return collectResults(stateMap);
}

/**
 * Project one wire task into the mutable pass state, recovering the pieces the
 * web `Task` type does not carry directly (issue #2813).
 *
 * The only genuinely derived value is `earlyStartMs`: the client is given the
 * SPAN start and the finish, never the server's `early_start`, so the
 * remaining-work window is reconstructed by walking `effectiveDurationDays`
 * back from the finish. That inversion is exact — `finishFromStart` and
 * `startFromFinish` walk the same working days — and it collapses to the span
 * start whenever the two windows coincide (not started, complete), which is why
 * a progress-free subgraph produces byte-identical output to the pre-#2813
 * engine.
 */
function toTaskState(t: CpmTask): TaskState {
  const spanStartMs = toMs(t.earlyStart);
  const earlyFinishMs = toMs(t.earlyFinish);
  const isComplete = t.isComplete ?? false;
  const actualStartMs = t.actualStart ? toMs(t.actualStart) : null;
  // ADR-0136: a completed task keeps its FULL duration — its remaining work is
  // zero, and laying it out at that would collapse the bar to a single day.
  const effectiveDurationDays =
    isComplete || t.remainingDuration == null ? t.durationDays : t.remainingDuration;

  return {
    id: t.id,
    earlyStartMs: startFromFinish(earlyFinishMs, effectiveDurationDays),
    earlyFinishMs,
    spanStartMs,
    lateFinishMs: toMs(t.lateFinish),
    // Working-day duration, not the calendar-ms span of the current dates
    // (see TaskState.durationDays doc — this is the calendar-blindness fix).
    durationDays: t.durationDays,
    effectiveDurationDays,
    // Mirrors `_pinned_placement`: completion alone is not enough — a task
    // complete only by percent_complete, with no actuals, still takes a
    // full-duration position through the network.
    isPinned: isComplete && (actualStartMs !== null || t.actualFinish != null),
    actualStartMs,
    isMilestone: t.isMilestone,
    name: t.name,
    baselineFinishMs: earlyFinishMs,
  };
}

/**
 * Place the drag target at the user's drop date, subject to the floors the
 * server will apply to the same value on commit (it lands as `planned_start`).
 *
 * A pinned task is left alone: the server's forward pass returns its actuals
 * before `planned_start` is ever consulted, so the honest preview of dragging
 * a completed bar is that nothing moves.
 */
function applyDrag(
  dragged: TaskState | undefined,
  newStartIso: string,
  statusDate: string | null | undefined,
): void {
  if (!dragged || dragged.isPinned) return;

  // Snap the drop target to a working day (mirrors the server's SNET handling
  // of planned_start), then raise it to the ES floors: the data date, and —
  // for work already underway — its recorded actual start.
  const plannedStartMs = nextWorkingDay(toMs(newStartIso));
  let earlyStartMs = plannedStartMs;
  if (statusDate) {
    const dataDateMs = nextWorkingDay(toMs(statusDate));
    if (dataDateMs > earlyStartMs) earlyStartMs = dataDateMs;
  }
  if (dragged.actualStartMs !== null && dragged.actualStartMs > earlyStartMs) {
    earlyStartMs = dragged.actualStartMs;
  }

  // The drop replaces this task's planned_start, so the span floor is the drop
  // itself — not the stale span the task arrived with.
  setEarlyWindow(dragged, earlyStartMs, plannedStartMs);
}

/**
 * Move a task's early window to `earlyStartMs` and re-derive everything that
 * follows from it: the finish (from the REMAINING duration) and the span start.
 *
 * `spanFloorMs` stands in for the task's `planned_start`, which the preview
 * does not carry: the bar paints `max(planned_start, scheduled_start)`
 * (ADR-0752), and for every task except the drag target that maximum is already
 * baked into the span it arrived with. Pass the incoming span for those, and
 * the drop date for the drag target, whose `planned_start` the commit replaces.
 *
 * The `scheduled_start` half mirrors `_compute_scheduled_start`: work with a
 * recorded start began when it began, so its span start stays put and only the
 * finish responds; everything else backs the FULL duration off the new finish,
 * which returns the early start unchanged for not-started work.
 */
function setEarlyWindow(task: TaskState, earlyStartMs: number, spanFloorMs: number): void {
  task.earlyStartMs = earlyStartMs;
  task.earlyFinishMs = finishFromStart(earlyStartMs, task.effectiveDurationDays);
  const scheduledStartMs =
    task.actualStartMs ?? startFromFinish(task.earlyFinishMs, task.durationDays);
  task.spanStartMs = Math.max(spanFloorMs, scheduledStartMs);
}

/**
 * Push each task forward to the latest date its predecessors allow, in
 * topological order (so every predecessor is final before its successors are
 * read). Mutates `stateMap` in place.
 *
 * The dragged task is skipped: its start is the user's input, not something the
 * network derives. Pinned tasks are skipped too — recorded actuals leave the
 * network entirely (ADR-0132 §2), so an upstream drag can never move them, even
 * though their unchanged finish still constrains everything below them.
 */
function relaxForward(
  order: string[],
  stateMap: Map<string, TaskState>,
  predecessors: Map<string, CpmEdge[]>,
  draggedTaskId: string,
): void {
  for (const taskId of order) {
    if (taskId === draggedTaskId) continue; // Already set by the caller.
    const task = stateMap.get(taskId);
    if (!task) continue;
    if (task.isPinned) continue; // Actuals are truth — never renegotiated.

    const preds = predecessors.get(taskId) ?? [];
    if (preds.length === 0) continue; // No predecessors — keep original dates.

    let maxEarlyStart = latestConstraint(preds, stateMap, task);
    // ADR-0132 §2: work already underway is floored at where it actually
    // started and is never smoothed back to an earlier network slot. Redundant
    // while this pass only pushes tasks forward, but the floor belongs with the
    // constraint set rather than resting on that invariant holding forever.
    if (task.actualStartMs !== null && task.actualStartMs > maxEarlyStart) {
      maxEarlyStart = task.actualStartMs;
    }
    if (maxEarlyStart > task.earlyStartMs) {
      setEarlyWindow(task, maxEarlyStart, task.spanStartMs);
    }
  }
}

/** The binding predecessor constraint, or -Infinity when none applies. */
function latestConstraint(
  preds: CpmEdge[],
  stateMap: Map<string, TaskState>,
  task: TaskState,
): number {
  let maxEarlyStart = -Infinity;
  for (const edge of preds) {
    const source = stateMap.get(edge.sourceId);
    if (!source) continue;
    const constraint = constraintFromEdge(edge, source, task);
    if (constraint > maxEarlyStart) maxEarlyStart = constraint;
  }
  return maxEarlyStart;
}

/**
 * Turn the relaxed state map into the preview payload, and pick the milestone
 * that slipped furthest — the one headline the drag overlay shows.
 */
function collectResults(stateMap: Map<string, TaskState>): {
  results: PreviewTaskResult[];
  worstMilestone: PreviewMilestone | null;
} {
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
      // The SPAN start, not the remaining-work window (ADR-0752, #2813) — this
      // is the value the preview bar paints from, so it must be the same
      // vocabulary the committed bar will use.
      earlyStart: toIso(task.spanStartMs),
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
