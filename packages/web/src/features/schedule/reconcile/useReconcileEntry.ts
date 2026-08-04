/**
 * Row-level reads of the reconciliation store (ADR-0784, issue #2725).
 *
 * These are selector hooks rather than props threaded down from `ScheduleView`
 * because `TaskListRow` is ~2,900 lines with many call sites, and adding two
 * more props to that chain to reach two leaf cells is how prop drilling becomes
 * permanent. The selectors are keyed reads, so a row only re-renders when *its*
 * entry changes.
 */
import { useReconcileStore } from '@/stores/reconcileStore';

import { reconcileKey, type ReconcileEntry, type ReconcileField } from './reconcileState';

/** The reconciliation entry for one task's date field, or undefined. */
export function useReconcileEntry(
  taskId: string,
  field: ReconcileField,
): ReconcileEntry | undefined {
  return useReconcileStore((s) => s.entries[reconcileKey(taskId, field)]);
}

/**
 * The project's effective working-day bitmask, as published by `ScheduleView`.
 *
 * It lives on the store so the two leaf date cells can reach it without a prop
 * chain. It is the ONLY input to the cause qualifier, and the only cause the
 * client can actually prove (ADR-0784 §D5).
 */
export function useWorkingDaysMask(): number {
  return useReconcileStore((s) => s.workingDaysMask);
}
