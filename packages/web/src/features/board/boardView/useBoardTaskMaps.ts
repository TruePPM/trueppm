import { useMemo } from 'react';
import type { Task, TaskStatus } from '@/types';
import {
  emptyStatusBuckets,
  emptyStatusCounts,
  passesBoardFilters,
  startOfToday,
  type BoardTaskFilters,
} from './boardFilters';

/** The unladen resolver: every card's track is its own status. */
function statusTrackKey(task: Task): string {
  return task.status;
}

/** Hoisted so the default keeps a stable identity across renders. */
const EMPTY_LANE_KEYS: readonly string[] = [];

/** Minimal shape of a swimlane the task maps need — id plus its cards. */
interface LaneLike {
  id: string;
  tasks: Task[];
}

/**
 * Per-phase, per-**track** task groupings with the active sort applied.
 *
 * A track is a status column, or one named lane of it (#2967) — see
 * `features/board/statusLanes.ts`. `trackKeyOf` resolves a card to its track;
 * with no lanes configured it returns the bare status, so the map is exactly the
 * per-status map this function has always produced.
 *
 * Lane buckets are seeded from `laneKeys` rather than discovered from the cards,
 * so a configured-but-empty lane still renders its (empty) cell instead of
 * silently vanishing from the grid.
 */
function buildPhaseTaskMap(
  phases: LaneLike[],
  filters: BoardTaskFilters,
  sortCell: (tasks: Task[]) => Task[],
  trackKeyOf: (task: Task) => string,
  laneKeys: readonly string[],
): Map<string, Record<string, Task[]>> {
  const today = startOfToday();
  const result = new Map<string, Record<string, Task[]>>();
  for (const phase of phases) {
    const byTrack: Record<string, Task[]> = emptyStatusBuckets();
    for (const key of laneKeys) byTrack[key] = [];
    for (const task of phase.tasks) {
      if (passesBoardFilters(task, filters, today)) byTrack[trackKeyOf(task)]?.push(task);
    }
    for (const key of Object.keys(byTrack)) {
      byTrack[key] = sortCell(byTrack[key]);
    }
    result.set(phase.id, byTrack);
  }
  return result;
}

/**
 * Flat per-status task lists for the mobile snap-scroll board. The phase ×
 * status grid collapses on mobile — each status column shows every matching
 * card across all phases as one list. Derived from the phase map so the same
 * task-level filters and sort carry through; only the phase grouping drops.
 * The sort is re-applied across the merged list so cross-phase order is
 * coherent (per-cell sort alone leaves phase-boundary jumps).
 *
 * Named lanes (#2967) are a desktop-grid subdivision and collapse here with the
 * phase axis: the mobile board keeps its five status lists, so a card is read
 * off its own `status` rather than off the track bucket it landed in.
 */
function flattenByStatus(
  phaseTaskMap: Map<string, Record<string, Task[]>>,
  sortCell: (tasks: Task[]) => Task[],
): Record<TaskStatus, Task[]> {
  const out = emptyStatusBuckets();
  for (const byTrack of phaseTaskMap.values()) {
    for (const cell of Object.values(byTrack)) {
      for (const task of cell) out[task.status]?.push(task);
    }
  }
  for (const s of Object.keys(out) as TaskStatus[]) {
    out[s] = sortCell(out[s]);
  }
  return out;
}

/** Live per-status card totals across every lane — the WIP-limit guard's input. */
function countByStatus(phases: LaneLike[]): Record<TaskStatus, number> {
  const counts = emptyStatusCounts();
  for (const phase of phases) {
    for (const task of phase.tasks) counts[task.status]++;
  }
  return counts;
}

/**
 * Per-column count of cards assigned to the current user — powers the quiet
 * "your cards are folded inside this stub" signal (#1696). Zero for every
 * column when the user has no resource identity on this project, so the signal
 * is simply absent rather than wrong.
 */
function countMineByStatus(
  phases: LaneLike[],
  myResourceId: string | null,
): Record<TaskStatus, number> {
  const counts = emptyStatusCounts();
  // Single return, rather than an early `return counts` on the null guard:
  // Sonar's S3516 reads two `return counts` paths as an invariant result
  // because its dataflow does not model the `counts[...]++` mutation between
  // them. Guarding the loop instead of returning early says the same thing.
  if (myResourceId !== null) {
    for (const phase of phases) {
      for (const task of phase.tasks) {
        if (task.assignees.some((a) => a.resourceId === myResourceId)) counts[task.status]++;
      }
    }
  }
  return counts;
}

export interface BoardTaskMaps {
  /** phaseId → track key → sorted cards. Track key is the status on an unladen
   *  column, `status#laneKey` on a named lane (#2967). */
  phaseTaskMap: Map<string, Record<string, Task[]>>;
  /** Flat per-status lists for the mobile snap board. */
  mobileTasksByStatus: Record<TaskStatus, Task[]>;
  /** Flat filtered list for the queue layout. */
  queueTasks: Task[];
  totalByStatus: Record<TaskStatus, number>;
  myCountByStatus: Record<TaskStatus, number>;
}

/**
 * Derive every task grouping the board's three layouts read, from one filter
 * definition. Extracted from `BoardView` for #2081 — behavior is unchanged; the
 * queue and grid now share `passesBoardFilters` instead of two hand-kept copies
 * of the same predicate chain.
 *
 * Note the deliberate asymmetry preserved from the original: the queue applies
 * `riskLinkedOnly` per task, while the grid applies it per *lane* (a lane
 * survives when any of its cards carries a risk) — so the grid's cell filter
 * omits it.
 */
export function useBoardTaskMaps(opts: {
  phases: LaneLike[];
  allTasks: Task[] | undefined;
  filters: BoardTaskFilters;
  sortCell: (tasks: Task[]) => Task[];
  /** Resolve a card to its board track. Omit on a board with no named lanes. */
  trackKeyOf?: (task: Task) => string;
  /** Every configured lane track key, so an empty lane still gets a cell. */
  laneKeys?: readonly string[];
}): BoardTaskMaps {
  const { phases, allTasks, filters, sortCell } = opts;
  const trackKeyOf = opts.trackKeyOf ?? statusTrackKey;
  const laneKeys = opts.laneKeys ?? EMPTY_LANE_KEYS;
  const { cpOnly, dueSoonDays, mineActive, myResourceId, debtOnly, riskLinkedOnly } = filters;

  const gridFilters = useMemo<BoardTaskFilters>(
    () => ({ cpOnly, dueSoonDays, mineActive, myResourceId, debtOnly }),
    [cpOnly, dueSoonDays, mineActive, myResourceId, debtOnly],
  );

  const phaseTaskMap = useMemo(
    () => buildPhaseTaskMap(phases, gridFilters, sortCell, trackKeyOf, laneKeys),
    [phases, gridFilters, sortCell, trackKeyOf, laneKeys],
  );

  const mobileTasksByStatus = useMemo(
    () => flattenByStatus(phaseTaskMap, sortCell),
    [phaseTaskMap, sortCell],
  );

  const queueTasks = useMemo(() => {
    const today = startOfToday();
    const queueFilters: BoardTaskFilters = { ...gridFilters, riskLinkedOnly };
    return (allTasks ?? []).filter(
      (t) => !t.isSummary && passesBoardFilters(t, queueFilters, today),
    );
  }, [allTasks, gridFilters, riskLinkedOnly]);

  const totalByStatus = useMemo(() => countByStatus(phases), [phases]);
  const myCountByStatus = useMemo(
    () => countMineByStatus(phases, myResourceId),
    [phases, myResourceId],
  );

  return { phaseTaskMap, mobileTasksByStatus, queueTasks, totalByStatus, myCountByStatus };
}
