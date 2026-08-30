import type { Task } from '@/types';

/** What a rollup produced, plus the two indexes a top-down pass needs after it. */
export interface RollupResult<R> {
  /** Row id → resolved value, one entry per row in `tasks`. */
  resolved: Map<string, R>;
  /**
   * Root ids in discovery order. Includes rows reached by the orphan pass, so a
   * caller inheriting downward starts from every subtree that was actually
   * walked rather than only from the true roots.
   */
  roots: string[];
  /** Parent id → child ids, reused by callers that then walk top-down. */
  childIds: Map<string, string[]>;
}

/**
 * Roll a value up a task outline, post-order, so a parent sees what every one of
 * its descendants contributed.
 *
 * `sprintBands.resolveRowSprints` and `deliveryModePresentation.computeRowModes`
 * had walks that were identical line for line, differing only in the two places
 * this signature parameterizes: what a single row contributes, and how a set of
 * contributions collapses into one resolved value.
 *
 * Three properties the callers depend on, none of them incidental:
 *
 * 1. **Iterative, not recursive.** A deep imported WBS would blow the call stack
 *    on a recursive walk. The explicit stack with an `expanded` flag is what
 *    makes the traversal post-order without recursion.
 * 2. **What a row hands UP is kept separate from what it resolves to.** A parent
 *    resolves to a single value only when its descendants agree, but it still
 *    contributes the *whole set* upward, so a grandparent sees the disagreement
 *    rather than a flattened "one of them". Collapsing the two would let one
 *    dissenting leaf read as agreement two levels up.
 * 3. **A row contributes its own value only when no descendant contributed.**
 *    That is what lets a gate — which contributes nothing — sit inside an
 *    otherwise uniform phase without marking the phase as mixed.
 *
 * Rows whose parent id points outside the loaded set (a filtered or collapsed
 * outline) are never reached from a root, so they are resolved standalone rather
 * than left unattributed and punching a hole through a band.
 *
 * @param contribute What this row hands up, or a falsy value for "nothing".
 * @param collapse How a set of contributions becomes the row's resolved value.
 */
export function postOrderRollup<T, R>(
  tasks: Task[],
  contribute: (task: Task) => T | null | undefined,
  collapse: (parts: Set<T>) => R,
): RollupResult<R> {
  const childIds = new Map<string, string[]>();
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    byId.set(task.id, task);
    if (task.parentId) {
      const siblings = childIds.get(task.parentId);
      if (siblings) siblings.push(task.id);
      else childIds.set(task.parentId, [task.id]);
    }
  }

  const resolved = new Map<string, R>();
  const contributed = new Map<string, Set<T>>();

  const walk = (rootId: string): void => {
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: rootId, expanded: false }];
    while (stack.length) {
      const frame = stack.pop();
      if (!frame) break;
      const kids = childIds.get(frame.id) ?? [];
      if (!frame.expanded && kids.length) {
        stack.push({ id: frame.id, expanded: true });
        for (const kid of kids) stack.push({ id: kid, expanded: false });
        continue;
      }
      const task = byId.get(frame.id);
      if (!task) continue;
      const parts = new Set<T>();
      for (const kid of kids) {
        for (const part of contributed.get(kid) ?? []) parts.add(part);
      }
      if (!parts.size) {
        const own = contribute(task);
        if (own) parts.add(own);
      }
      contributed.set(frame.id, parts);
      resolved.set(frame.id, collapse(parts));
    }
  };

  const roots: string[] = [];
  for (const task of tasks) {
    if (!task.parentId || !byId.has(task.parentId)) {
      roots.push(task.id);
      walk(task.id);
    }
  }
  for (const task of tasks) {
    if (!resolved.has(task.id)) {
      roots.push(task.id);
      walk(task.id);
    }
  }

  return { resolved, roots, childIds };
}
