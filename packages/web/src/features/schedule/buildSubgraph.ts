/**
 * Extract the downstream subgraph reachable from a given task (inclusive).
 *
 * The CPM worker needs only the tasks and links that are affected by a drag —
 * upstream tasks are irrelevant to the forward pass. This keeps the worker
 * payload small for large schedules.
 *
 * Summary dependencies are expanded to leaf level first (issue #3535). A
 * summary's children are WBS containment, not link edges, so a BFS over literal
 * `TaskLink` rows could not reach a task gated on a summary from a drag that
 * started inside the phase — the successor was ABSENT from the preview, not
 * miscalculated. See {@link expandSummaryLinks}.
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

  const childrenByParent = buildChildrenMap(tasks);
  const effectiveLinks = expandSummaryLinks(links, childrenByParent, startTaskId);

  // Build adjacency list: sourceId → outgoing links
  const outgoing = new Map<string, TaskLink[]>();
  for (const t of tasks) outgoing.set(t.id, []);
  for (const link of effectiveLinks) {
    outgoing.get(link.sourceId)?.push(link);
  }

  const visited = reachableFrom(startTaskId, outgoing);
  return {
    tasks: toCpmTasks(visited, taskIndex),
    edges: internalEdges(effectiveLinks, visited),
  };
}

/**
 * Map each parent task's id to its direct children's ids.
 *
 * Mirrors the server's `_build_children_map` (`scheduling/tasks.py`), which
 * keys the same map by WBS parenthood. This does NOT re-derive that
 * relationship: `Task.parentId` IS the server's `parent_id`, a read-only
 * annotation computed from `wbs_path` (`projects/views.py`), so the client and
 * the server are reading one containment fact rather than two implementations
 * of it. A task with at least one entry here is a summary, the same predicate
 * `expand_summary_dependencies` applies.
 */
function buildChildrenMap(tasks: Task[]): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const siblings = childrenByParent.get(t.parentId);
    if (siblings) siblings.push(t.id);
    else childrenByParent.set(t.parentId, [t.id]);
  }
  return childrenByParent;
}

/** Every leaf descendant of `id` — or `[id]` itself when it has no children. */
function collectLeaves(id: string, childrenByParent: Map<string, string[]>): string[] {
  const leaves: string[] = [];
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const node = stack.pop()!;
    // A malformed tree (a parent cycle, or a node reachable by two paths) must
    // not spin here — the server's `_collect_leaves` guards the same way.
    if (seen.has(node)) continue;
    seen.add(node);
    const children = childrenByParent.get(node);
    if (children === undefined || children.length === 0) leaves.push(node);
    else stack.push(...children);
  }
  return leaves;
}

/**
 * Replace every link touching a summary with the leaf-level cross product of
 * its endpoints, mirroring the server's `expand_summary_dependencies`
 * (`packages/scheduler/src/trueppm_scheduler/engine.py`).
 *
 * This is a deliberate MIRROR of a server rule, which carries drift risk — if
 * the server's expansion changes, this silently disagrees. It is the shape
 * chosen anyway because the alternative is worse in a way the preview cannot
 * absorb: the expanded edge set is a property of the whole project network, and
 * the drag preview must produce a new answer per animation frame with no
 * network round trip (ADR-0599's offline/preview carve-out). Serving it from
 * the API would put a fetch on the drag path. What bounds the risk is that the
 * rule's INPUT is not mirrored — `parentId` is the server's own annotation (see
 * {@link buildChildrenMap}) — so only the fan-out itself is duplicated, and
 * `cpmEngine.conformance.test.ts` is where a divergence would be caught.
 *
 * Two deviations from the server, both deliberate:
 *
 *  - **SS/SF from a summary is dropped, not expanded.** ADR-0370 /
 *    `_reject_summary_start_links` rejects that link outright, because fanning
 *    a start-side constraint across every leaf turns the successor's `max()`
 *    into "wait for the LAST-starting leaf" and silently over-constrains it
 *    (the #1854 bug). Such a link cannot survive a server CPM run at all, so
 *    the honest preview of one is to show nothing rather than a slip the
 *    server will never produce.
 *  - **A summary that is the drag ROOT keeps its own outgoing links.** The
 *    server drops summary nodes because it recomputes their dates by rollup
 *    (`apply_summary_rollups`); the preview has no rollup pass, so dropping the
 *    node the user is dragging would leave an empty subgraph. Keeping its
 *    literal edges preserves exactly the pre-#3535 behavior for that gesture
 *    rather than regressing it to nothing. Scoped to the root: any OTHER
 *    summary is fully expanded, so a stale summary-anchored constraint can
 *    never block the pull-in that mechanism 1 now performs.
 */
type LinkDisposition = 'keep' | 'drop' | 'expand';

/**
 * Which of the three summary-expansion outcomes `link` takes — see the
 * docstring above for why each rule exists.
 */
function classifyLink(
  link: TaskLink,
  isSummary: (id: string) => boolean,
  startTaskId: string,
): LinkDisposition {
  const sourceIsSummary = isSummary(link.sourceId);
  const targetIsSummary = isSummary(link.targetId);

  if (!sourceIsSummary && !targetIsSummary) return 'keep';
  if (sourceIsSummary && link.sourceId === startTaskId) {
    // The drag root is ITSELF the summary — see the docstring's second
    // deviation. Deliberately not "the root is this link's source": a leaf
    // root linked INTO a phase (`A -> S`) must still expand, or the drag
    // reaches the summary node and stops, which is the very absence #3535 is
    // about.
    return 'keep';
  }
  if (sourceIsSummary && (link.type === 'SS' || link.type === 'SF')) {
    return 'drop'; // ADR-0370: the server refuses to schedule this link at all.
  }
  return 'expand';
}

/** The leaf-level cross product of `link`'s endpoints, deduped against `seen`. */
function crossProductEdges(
  link: TaskLink,
  leaves: (id: string) => string[],
  seen: Set<string>,
): TaskLink[] {
  const edges: TaskLink[] = [];
  for (const source of leaves(link.sourceId)) {
    for (const target of leaves(link.targetId)) {
      // A summary→summary link inside one phase expands onto pairs of its own
      // leaves; a self-edge is not a dependency and would deadlock the sort.
      if (source === target) continue;
      const key = `${source}\u0000${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ ...link, sourceId: source, targetId: target });
    }
  }
  return edges;
}

function expandSummaryLinks(
  links: TaskLink[],
  childrenByParent: Map<string, string[]>,
  startTaskId: string,
): TaskLink[] {
  if (childrenByParent.size === 0) return links;

  const leavesOf = new Map<string, string[]>();
  const leaves = (id: string): string[] => {
    let cached = leavesOf.get(id);
    if (cached === undefined) {
      cached = collectLeaves(id, childrenByParent);
      leavesOf.set(id, cached);
    }
    return cached;
  };
  const isSummary = (id: string): boolean => (childrenByParent.get(id)?.length ?? 0) > 0;

  const expanded: TaskLink[] = [];
  // Deduplicate on the endpoint pair, matching the server's `_cross_product_edges`:
  // two summary links landing on the same leaf pair yield one edge.
  const seen = new Set<string>();

  for (const link of links) {
    const disposition = classifyLink(link, isSummary, startTaskId);
    if (disposition === 'drop') continue;
    if (disposition === 'keep') {
      expanded.push(link);
      continue;
    }
    expanded.push(...crossProductEdges(link, leaves, seen));
  }
  return expanded;
}

/** Every task id reachable downstream of `startTaskId`, including itself. */
function reachableFrom(startTaskId: string, outgoing: Map<string, TaskLink[]>): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [startTaskId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const link of outgoing.get(id) ?? []) {
      if (!visited.has(link.targetId)) queue.push(link.targetId);
    }
  }
  return visited;
}

/**
 * Links with both endpoints inside the subgraph. A link that leaves the
 * subgraph imposes nothing on the preview, since its target is not recomputed.
 */
function internalEdges(links: TaskLink[], visited: Set<string>): CpmEdge[] {
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
  return edges;
}

/** Project the visited tasks into the shape the preview engine consumes. */
function toCpmTasks(visited: Set<string>, taskIndex: Map<string, Task>): CpmTask[] {
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
      // FULL working-day duration. The engine derives the remaining portion
      // itself from `remainingDuration` (issue #2813) — feeding it the full
      // duration for an in-progress task was what made the preview lay 10 days
      // of already-80%-burned work in front of every successor.
      durationDays: t.duration,
      isMilestone: t.isMilestone,
      name: t.name,
      // ADR-0132 progress facts. All four already exist on the web Task; the
      // preview simply never carried them across the worker boundary.
      isComplete: t.isComplete,
      actualStart: t.actualStart ?? null,
      actualFinish: t.actualFinish ?? null,
      remainingDuration: t.remainingDuration ?? null,
      // The SNET lower bound (#3535). Inert while the preview only pushed
      // tasks forward — a task's current start already satisfied its own
      // `planned_start` — and load-bearing now that a drag can pull its
      // successors earlier, which is precisely the move that would otherwise
      // slide a task through a date its PM pinned.
      plannedStart: t.plannedStart ?? null,
    });
  }
  return cpmTasks;
}
