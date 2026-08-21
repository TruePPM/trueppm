/**
 * Why each date moved, and in what order to say it (#2965).
 *
 * When the engine recomputes, a planner is handed a set of changed dates. As a
 * flat list that is nearly useless: twelve rows moved, and nothing says whether
 * that is twelve problems or **one problem and eleven consequences**. Those are
 * completely different situations and they look identical.
 *
 * This orders the moved set by its causal chain and names each row's driver:
 * the predecessor that moved and pushed it. Rows that moved for their own
 * reason — nothing upstream of them changed — come first and carry no driver.
 * They are the ones worth reading.
 */
import type { Task } from '@/types';

export interface ChainLink {
  /** Predecessor. */
  sourceId: string;
  /** Successor. */
  targetId: string;
}

export interface MovedRow {
  taskId: string;
  taskName: string;
}

export interface CausalRow extends MovedRow {
  /**
   * The moved predecessor that pushed this row, or `null` when it moved on its
   * own account. `null` is the interesting case — those are the causes.
   */
  driverId: string | null;
  driverName: string | null;
  /**
   * How far down the chain this row sits. 0 = moved for its own reason. Used to
   * indent, so a chain reads as a chain rather than a list.
   */
  depth: number;
}

/**
 * Order the moved rows so causes precede consequences, and attribute each
 * consequence to its driver.
 *
 * A row's driver is the predecessor that **also moved**. When several did, the
 * one earliest in the chain wins — that is the row a planner should look at,
 * not the last domino.
 *
 * Cycles cannot happen in a valid plan (the server's graph guard rejects them),
 * but a stale client cache can hold one, so the walk is bounded by a visited set
 * rather than trusting the graph.
 */
export function orderByCausalChain(
  moved: readonly MovedRow[],
  links: readonly ChainLink[],
  tasks: readonly Task[],
): CausalRow[] {
  const movedIds = new Set(moved.map((m) => m.taskId));
  const nameById = new Map<string, string>(tasks.map((t) => [t.id, t.name]));
  for (const m of moved) nameById.set(m.taskId, m.taskName);

  // Predecessors, restricted to the ones that also moved — an unmoved
  // predecessor did not cause anything.
  const movedPreds = new Map<string, string[]>();
  for (const link of links) {
    if (!movedIds.has(link.targetId) || !movedIds.has(link.sourceId)) continue;
    const preds = movedPreds.get(link.targetId) ?? [];
    preds.push(link.sourceId);
    movedPreds.set(link.targetId, preds);
  }

  /** Depth = longest path back to a row that moved on its own account. */
  function depthOf(id: string, seen: Set<string>): number {
    if (seen.has(id)) return 0; // stale-cache cycle — stop rather than hang
    const preds = movedPreds.get(id);
    if (!preds || preds.length === 0) return 0;
    seen.add(id);
    const deepest = Math.max(...preds.map((p) => depthOf(p, seen)));
    seen.delete(id);
    return deepest + 1;
  }

  const rows: CausalRow[] = moved.map((m) => {
    const preds = movedPreds.get(m.taskId) ?? [];
    // The earliest mover in the chain is the one to name — a planner wants the
    // cause, not the domino nearest to them.
    let driverId: string | null = null;
    let best = Infinity;
    for (const p of preds) {
      const d = depthOf(p, new Set());
      if (d < best) {
        best = d;
        driverId = p;
      }
    }
    return {
      ...m,
      driverId,
      driverName: driverId ? (nameById.get(driverId) ?? null) : null,
      depth: depthOf(m.taskId, new Set()),
    };
  });

  // Causes first, then their consequences; stable by name inside a depth so the
  // list does not reshuffle between recomputes for no reason.
  return rows.sort(
    (a, b) => a.depth - b.depth || a.taskName.localeCompare(b.taskName),
  );
}

/**
 * The one-line summary above the list.
 *
 * Says how many rows moved **on their own account** versus how many followed,
 * because that is the distinction the flat list destroys. "12 dates changed" is
 * alarming and uninformative; "1 change moved 11 other dates" is actionable.
 */
export function summarizeCausalChain(rows: readonly CausalRow[]): string {
  const total = rows.length;
  if (total === 0) return 'No dates changed.';
  const causes = rows.filter((r) => r.driverId === null).length;
  const followed = total - causes;
  if (followed === 0) {
    return total === 1 ? '1 date changed.' : `${total} dates changed independently.`;
  }
  const causeWord = causes === 1 ? 'change' : 'changes';
  const followedWord = followed === 1 ? 'other date' : 'other dates';
  return `${causes} ${causeWord} moved ${followed} ${followedWord}.`;
}
