import type { Task } from '@/types';

/**
 * Which rows may be offered as a predecessor without forming a cycle (#2958).
 *
 * The picker previously offered every unlinked row and let the server's
 * cycle-detection `400` catch the bad ones — so a planner found out that a link
 * was impossible *after* choosing it, with no way to tell which of the offered
 * rows were real options.
 *
 * **Not every edge in this graph is an explicit link.** Two are structural, and
 * missing them is what makes a naive check wrong rather than merely incomplete:
 *
 *  - **A gate derives its date from the work in its phase.** A milestone (or any
 *    zero-duration leaf) implicitly waits on its siblings, so a row downstream of
 *    that gate must never be offered as a predecessor for work inside the same
 *    phase.
 *  - **A phase derives its dates from its children.** A container implicitly
 *    waits on everything beneath it.
 *
 * Walking only the explicit links therefore offers rows that close a loop
 * *through* a gate or a phase — which the server rejects, correctly, leaving the
 * user with a refusal they cannot act on.
 *
 * Pure and task-shaped rather than a graph library: the whole rule is "can B
 * reach A", and expressing it directly is what makes the implicit edges legible.
 */

export interface CycleLink {
  /** Predecessor. */
  sourceId: string;
  /** Successor. */
  targetId: string;
}

/** A leaf that marks a moment rather than consuming time. */
function isGate(task: Task, hasChildren: boolean): boolean {
  return !hasChildren && (task.isMilestone || task.duration <= 0);
}

/**
 * Every row `task` implicitly waits on, by structure alone.
 *
 * Deliberately mirrors the server's scheduling semantics rather than the
 * dependency table: these edges have no row anywhere, which is exactly why a
 * client-side check that reads only `allLinks` gets them wrong.
 */
function implicitPredecessors(
  task: Task,
  byParent: ReadonlyMap<string | null, Task[]>,
  childCount: ReadonlyMap<string, number>,
): Task[] {
  const out: Task[] = [];
  const hasChildren = (childCount.get(task.id) ?? 0) > 0;

  if (isGate(task, hasChildren) && task.parentId) {
    // A gate waits on the real work beside it — but not on its fellow gates,
    // which would make two milestones in one phase mutually blocking.
    for (const sibling of byParent.get(task.parentId) ?? []) {
      if (sibling.id === task.id) continue;
      if (isGate(sibling, (childCount.get(sibling.id) ?? 0) > 0)) continue;
      out.push(sibling);
    }
  }

  if (hasChildren) out.push(...(byParent.get(task.id) ?? []));

  return out;
}

/**
 * True when `from` already depends on `to`, directly or through any chain —
 * explicit links and structural edges alike.
 */
export function dependsOn(
  from: Task,
  to: Task,
  tasks: readonly Task[],
  links: readonly CycleLink[],
): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byParent = new Map<string | null, Task[]>();
  const childCount = new Map<string, number>();
  for (const t of tasks) {
    const siblings = byParent.get(t.parentId) ?? [];
    siblings.push(t);
    byParent.set(t.parentId, siblings);
    if (t.parentId) childCount.set(t.parentId, (childCount.get(t.parentId) ?? 0) + 1);
  }

  const explicitPreds = new Map<string, string[]>();
  for (const link of links) {
    const preds = explicitPreds.get(link.targetId) ?? [];
    preds.push(link.sourceId);
    explicitPreds.set(link.targetId, preds);
  }

  const seen = new Set<string>();
  const stack: Task[] = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    // A cycle already in the data must terminate the walk, not hang the picker.
    if (seen.has(current.id)) continue;
    seen.add(current.id);

    for (const predId of explicitPreds.get(current.id) ?? []) {
      if (predId === to.id) return true;
      const pred = byId.get(predId);
      if (pred) stack.push(pred);
    }
    for (const pred of implicitPredecessors(current, byParent, childCount)) {
      if (pred.id === to.id) return true;
      stack.push(pred);
    }
  }
  return false;
}

/**
 * Ids that must NOT be offered as a predecessor of `task`.
 *
 * Three reasons a row is ineligible, and the union is what the picker excludes:
 * it is the task itself, it is inside the task's own subtree, or linking it
 * would close a loop.
 *
 * Phases are deliberately **not** excluded for being phases — waiting on a whole
 * phase is the most common link there is, and the cycle walk already follows
 * container → children, so a phase containing the row is ruled out on its own.
 */
export function ineligiblePredecessorIds(
  task: Task,
  tasks: readonly Task[],
  links: readonly CycleLink[],
): Set<string> {
  const out = new Set<string>([task.id]);

  const byParent = new Map<string | null, Task[]>();
  for (const t of tasks) {
    const siblings = byParent.get(t.parentId) ?? [];
    siblings.push(t);
    byParent.set(t.parentId, siblings);
  }
  const stack = [...(byParent.get(task.id) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (out.has(node.id)) continue;
    out.add(node.id);
    stack.push(...(byParent.get(node.id) ?? []));
  }

  for (const candidate of tasks) {
    if (out.has(candidate.id)) continue;
    if (dependsOn(candidate, task, tasks, links)) out.add(candidate.id);
  }
  return out;
}
