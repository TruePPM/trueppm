import type { RefObject } from 'react';
import { useScheduleStore } from '@/stores/scheduleStore';

/**
 * The selected and scroll-target ids the v2 10-child cap must exempt (#5106).
 *
 * Returns an id only while the cap is HIDING that row (`hiddenRef`); for a row
 * already on screen it returns null. The row-list memo depends on these values,
 * so selecting a visible row leaves its input unchanged and the capped list is not
 * rebuilt, while reaching for a hidden row (search, deep link, keyboard jump)
 * changes the input and reveals it.
 *
 * @param active - The cap is in force (shell v2, no "no committed start" filter).
 * @param hiddenRef - Rows the cap hides right now, written by the row-list memo.
 */
export function useCapExemptIds(
  active: boolean,
  hiddenRef: RefObject<ReadonlySet<string>>,
): { selectedForCap: string | null; scrollTargetForCap: string | null } {
  const exempt = (id: string | null) =>
    active && id !== null && hiddenRef.current.has(id) ? id : null;
  const selectedForCap = useScheduleStore((s) => exempt(s.selectedTaskId));
  const scrollTargetForCap = useScheduleStore((s) => exempt(s.scrollToTaskId));
  return { selectedForCap, scrollTargetForCap };
}
