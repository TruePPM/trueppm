import { useMemo } from 'react';
import type { Task, TaskStatus } from '@/types';
import {
  emptyStatusBuckets,
  emptyStatusCounts,
  passesBoardFilters,
  startOfToday,
  type BoardTaskFilters,
} from './boardFilters';

/** Minimal shape of a swimlane the task maps need — id plus its cards. */
interface LaneLike {
  id: string;
  tasks: Task[];
}

/** Per-phase, per-status task groupings with the active sort applied. */
function buildPhaseTaskMap(
  phases: LaneLike[],
  filters: BoardTaskFilters,
  sortCell: (tasks: Task[]) => Task[],
): Map<string, Record<TaskStatus, Task[]>> {
  const today = startOfToday();
  const result = new Map<string, Record<TaskStatus, Task[]>>();
  for (const phase of phases) {
    const byStatus = emptyStatusBuckets();
    for (const task of phase.tasks) {
      if (passesBoardFilters(task, filters, today)) byStatus[task.status]?.push(task);
    }
    for (const s of Object.keys(byStatus) as TaskStatus[]) {
      byStatus[s] = sortCell(byStatus[s]);
    }
    result.set(phase.id, byStatus);
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
 */
function flattenByStatus(
  phaseTaskMap: Map<string, Record<TaskStatus, Task[]>>,
  sortCell: (tasks: Task[]) => Task[],
): Record<TaskStatus, Task[]> {
  const out = emptyStatusBuckets();
  for (const byStatus of phaseTaskMap.values()) {
    for (const s of Object.keys(out) as TaskStatus[]) {
      const cell = byStatus[s];
      if (cell?.length) out[s].push(...cell);
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
  /** phaseId → status → sorted cards. */
  phaseTaskMap: Map<string, Record<TaskStatus, Task[]>>;
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
}): BoardTaskMaps {
  const { phases, allTasks, filters, sortCell } = opts;
  const { cpOnly, dueSoonDays, mineActive, myResourceId, debtOnly, riskLinkedOnly } = filters;

  const gridFilters = useMemo<BoardTaskFilters>(
    () => ({ cpOnly, dueSoonDays, mineActive, myResourceId, debtOnly }),
    [cpOnly, dueSoonDays, mineActive, myResourceId, debtOnly],
  );

  const phaseTaskMap = useMemo(
    () => buildPhaseTaskMap(phases, gridFilters, sortCell),
    [phases, gridFilters, sortCell],
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
