import type { Task, TaskStatus } from '@/types';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';
import { ROOT_LANE_ID, buildLaneIndex, collectLaneHeads } from '../laneAssignment';
import { wipState, type WipState } from '../wip';

/** A phase lane of the Pass 2 board: a container's cards, grouped under one header. */
export interface Board2Lane {
  id: string;
  name: string;
  tasks: Task[];
}

/** Float, in working days, at or under which a not-yet-critical card reads as near-critical. */
export const NEAR_CRITICAL_FLOAT_DAYS = 5;

/** Cards a Done cell shows before collapsing the rest behind "N more done". */
export const DONE_VISIBLE = 2;

/**
 * Group the committed cards into phase lanes. Reuses the shipped lane rule
 * (`laneAssignment`): a container is never a card, root-level work lands in a lane
 * named for the project, and a lane with no cards is absent. `lanesOn === false`
 * flattens everything into one lane, which the page renders without a lane header.
 * `keep` narrows the CARDS only: the containers that name the lanes must stay in
 * `tasks`, or a filtered board loses its phases and every card falls into the root lane.
 */
export function groupIntoLanes(
  tasks: readonly Task[],
  projectName: string | undefined,
  lanesOn = true,
  keep: (t: Task) => boolean = () => true,
): Board2Lane[] {
  const placements = buildLaneIndex(tasks);
  const byLane = new Map<string, Task[]>();
  for (const t of tasks) {
    const placement = placements.get(t.id);
    if (!placement || !keep(t)) continue;
    const arr = byLane.get(placement.laneId) ?? [];
    arr.push(t);
    byLane.set(placement.laneId, arr);
  }
  if (!lanesOn) {
    const all = [...byLane.values()].flat();
    return all.length > 0 ? [{ id: 'all', name: projectName ?? 'Project', tasks: all }] : [];
  }
  const lanes: Board2Lane[] = collectLaneHeads(tasks)
    .map((head) => ({ id: head.id, name: head.name, tasks: byLane.get(head.id) ?? [] }))
    .filter((l) => l.tasks.length > 0);
  const root = byLane.get(ROOT_LANE_ID) ?? [];
  if (root.length > 0)
    lanes.push({ id: ROOT_LANE_ID, name: projectName ?? 'Project', tasks: root });
  return lanes;
}

export interface LaneSummary {
  count: number;
  critical: number;
  /** ISO dates of the earliest start and latest finish among the lane's cards, if any card is dated. */
  start: string | null;
  finish: string | null;
}

/** Header facts for one lane: card count, critical-card count and the date span. */
export function summarizeLane(tasks: readonly Task[]): LaneSummary {
  let start: string | null = null;
  let finish: string | null = null;
  let critical = 0;
  for (const t of tasks) {
    if (t.isCritical) critical += 1;
    if (t.start && (start === null || t.start < start)) start = t.start;
    if (t.finish && (finish === null || t.finish > finish)) finish = t.finish;
  }
  return { count: tasks.length, critical, start, finish };
}

export interface ColumnHead {
  status: TaskStatus;
  label: string;
  count: number;
  wipLimit: number | null;
  wip: WipState;
}

/** Per-status header facts across the whole board. WIP flagging is advisory (never blocks a drop). */
export function columnHeads(
  columns: readonly BoardColumnDef[],
  tasks: readonly Task[],
): ColumnHead[] {
  const placements = buildLaneIndex(tasks);
  const counts = new Map<TaskStatus, number>();
  for (const t of tasks) {
    if (!placements.has(t.id)) continue;
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  }
  return columns.map((c) => {
    const count = counts.get(c.status) ?? 0;
    return {
      status: c.status,
      label: c.label,
      count,
      wipLimit: c.wipLimit,
      wip: wipState(count, c.wipLimit),
    };
  });
}

export type CardChip =
  | { kind: 'critical' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'near'; floatDays: number };

/** The status chips a card wears, in priority order. Blocked and critical can both show. */
export function cardChips(t: Task): CardChip[] {
  const chips: CardChip[] = [];
  if (t.isCritical) chips.push({ kind: 'critical' });
  const reason = (t.blockedReason ?? '').trim();
  if (reason || t.isBlocked)
    chips.push({ kind: 'blocked', reason: reason || 'waiting on a predecessor' });
  const f = t.totalFloat;
  if (!t.isCritical && f != null && f > 0 && f <= NEAR_CRITICAL_FLOAT_DAYS) {
    chips.push({ kind: 'near', floatDays: f });
  }
  return chips;
}

/** Board filter: both toggles narrow (AND). */
export interface Board2Filter {
  criticalOnly: boolean;
  blockedOnly: boolean;
}

export function applyFilter(tasks: readonly Task[], f: Board2Filter): Task[] {
  return tasks.filter(
    (t) =>
      (!f.criticalOnly || t.isCritical) && (!f.blockedOnly || !!t.blockedReason || !!t.isBlocked),
  );
}

/** Cells in a Done column: the first {@link DONE_VISIBLE} and how many are folded. */
export function splitDone<T>(
  cards: readonly T[],
  expanded: boolean,
): { shown: T[]; hidden: number } {
  if (expanded || cards.length <= DONE_VISIBLE) return { shown: [...cards], hidden: 0 };
  return { shown: cards.slice(0, DONE_VISIBLE), hidden: cards.length - DONE_VISIBLE };
}
