/**
 * Board lane assignment — the case 16 rendering rule (#2947, epic #2946).
 *
 * One object, one rendering. Three invariants, and every board grouping obeys
 * all three:
 *
 *  1. **A container is never a card.** A row with structural children is a lane,
 *     a summary row, or a timeline band — never a work item in a column, at any
 *     depth, in any grouping.
 *  2. **Every task appears exactly once**, in the lane of its *top-level*
 *     container ancestor. Containers nested below that lane travel on the card
 *     as a crumb, so a four-level WBS makes five lanes instead of forty.
 *  3. **Root-level work belongs to the project node**, which is a real object —
 *     so its lane carries the project's name rather than a synthetic label, and
 *     is absent when it holds nothing.
 *
 * Why the *top-level* ancestor and not the nearest one: lanes are the board's
 * top-level grouping (`group_depth = 1`). The nearest container is what the
 * crumb names. Measured 2026-08-18 across the local instance, 94.9% of leaf
 * rows sit at WBS depth <= 2 and carry no crumb at all, and only 2 of 21
 * projects reach depth 3 — which is why this ships without a grouping-depth
 * selector (case 16 `decide:`, risk 3).
 *
 * Container-ness is *derived* here, from structural child count, exactly as the
 * server derives `is_summary` (`task_is_phase()`, models.py:2245). That is the
 * root defect this rule works around rather than fixes: a row's identity is
 * still retroactive, so a childless row a user created as a phase is
 * indistinguishable from a task and still renders as a card. Declaring the role
 * — `structure_role`, and with it legal empty containers — is 0.5 (#2946).
 */
import type { Task } from '@/types';

/** Sentinel lane id for work that hangs directly off the project node. */
export const ROOT_LANE_ID = 'root';

export interface LanePlacement {
  /** Lane this card renders in — a real container id, or {@link ROOT_LANE_ID}. */
  laneId: string;
  /**
   * Name of the card's own container parent when that container is *not* the
   * lane itself — i.e. the deeper structure the lane cannot show. `null` when
   * the card sits directly in its lane, which is the overwhelming majority.
   */
  crumb: string | null;
}

/**
 * True when `task` has at least one structural child.
 *
 * Prefers the server's `isSummary` (authoritative, and the same probe the
 * rollup locks use). Falls back to observed parentage so a lane still forms on
 * a payload from a server that did not annotate it, and so an optimistic child
 * inserted client-side promotes its parent in the same render rather than one
 * refetch later.
 */
function isContainer(task: Task, parentIds: ReadonlySet<string>): boolean {
  return task.isSummary || parentIds.has(task.id);
}

/**
 * Every id observed as some row's parent — the fallback half of
 * {@link isContainer}, shared so the lane index and the lane heads cannot
 * disagree about which rows are containers.
 */
function collectParentIds(allTasks: readonly Task[]): Set<string> {
  const parentIds = new Set<string>();
  for (const t of allTasks) {
    if (t.parentId) parentIds.add(t.parentId);
  }
  return parentIds;
}

/**
 * Walk to the top of `task`'s container chain, remembering the first step: the
 * top-most ancestor is the lane, the nearest is the crumb.
 *
 * A cycle in `parentId` terminates the walk rather than hanging the board, and
 * a parent id pointing outside the loaded set stops it at the last row we hold.
 */
function resolveChain(
  task: Task,
  byId: ReadonlyMap<string, Task>,
): { top: Task | undefined; nearest: Task | undefined } {
  const nearest = task.parentId ? byId.get(task.parentId) : undefined;
  let top = nearest;
  const seen = new Set<string>();
  while (top?.parentId && !seen.has(top.id)) {
    seen.add(top.id);
    const next = byId.get(top.parentId);
    if (!next) break;
    top = next;
  }
  return { top, nearest };
}

/**
 * Assign every non-container task to a lane, with a crumb for the deeper
 * structure the lane cannot show.
 *
 * Containers are deliberately absent from the result: invariant 1 means there
 * is no placement to give them. A cycle in `parentId` (which the server's graph
 * guard rejects, but a stale cache can still hold) terminates the walk rather
 * than hanging the board.
 */
export function buildLaneIndex(allTasks: readonly Task[]): Map<string, LanePlacement> {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const parentIds = collectParentIds(allTasks);

  const placements = new Map<string, LanePlacement>();

  for (const task of allTasks) {
    if (isContainer(task, parentIds)) continue;

    const { top, nearest } = resolveChain(task, byId);

    if (!top) {
      placements.set(task.id, { laneId: ROOT_LANE_ID, crumb: null });
      continue;
    }
    placements.set(task.id, {
      laneId: top.id,
      crumb: nearest && nearest.id !== top.id ? nearest.name : null,
    });
  }

  return placements;
}

/**
 * The containers that become lanes, in board order: top-level containers only.
 *
 * A container nested inside another is *not* a lane — its work surfaces in its
 * top-level ancestor's lane wearing a crumb. This is what keeps a deep WBS from
 * producing a lane per node.
 */
export function collectLaneHeads(allTasks: readonly Task[]): Task[] {
  const parentIds = collectParentIds(allTasks);
  return allTasks.filter((t) => t.parentId === null && isContainer(t, parentIds));
}
