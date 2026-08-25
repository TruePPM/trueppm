import { useEffect, useSyncExternalStore } from 'react';
import {
  CHART_HEADER_HEIGHT,
  getCadenceRail,
  subscribeCadenceRail,
  syncCadenceRail,
} from '@/features/schedule/scheduleConstants';

/** SSR draws no canvas and therefore no rail — the same default as the store's. */
function getCadenceRailServerSnapshot(): boolean {
  return false;
}

/**
 * The y at which the Schedule's row 0 starts — the date ruler's height, plus the
 * sprint cadence rail's when it is drawn (#3012).
 *
 * Two jobs, exactly as `useRowHeight` has:
 *
 * 1. **Subscribe.** A React consumer that merely reads the `CHART_HEADER_HEIGHT`
 *    live binding gets the right number but never re-renders when the rail
 *    appears — which it does asynchronously, the first time a project's sprints
 *    resolve. `useSyncExternalStore` over the module's own listener set turns
 *    that into a render.
 * 2. **Return what the engine has**, not a parallel calculation. The value comes
 *    straight off the binding the renderer and hit index read, so the outline
 *    header and the canvas cannot resolve two different origins inside one
 *    commit. A hook computing `28 + (rail ? 16 : 0)` itself would be the second
 *    definition web rule 315 forbids.
 */
export function useChartHeaderHeight(): number {
  useSyncExternalStore(subscribeCadenceRail, getCadenceRail, getCadenceRailServerSnapshot);
  return CHART_HEADER_HEIGHT;
}

/**
 * Install whether the cadence rail is drawn (#3012).
 *
 * Called by the one component that can resolve it — `ScheduleView`, which is
 * where the "Sprint windows" display option and the computed windows meet.
 * Everybody else *reads* the resolved origin through `useChartHeaderHeight()`
 * and never sees the flag, which is the point: the rail is a second **input** to
 * the single owner, not a second geometry source each consumer must remember.
 *
 * Written from an effect rather than during render because `syncCadenceRail`
 * notifies subscribers, and notifying during another component's render is the
 * "cannot update a component while rendering a different component" warning.
 *
 * The cleanup retracts the rail, so leaving the Schedule cannot leave a stale
 * `true` latched for a surface that shares the row model but paints no rail.
 */
export function useCadenceRail(visible: boolean): void {
  useEffect(() => {
    syncCadenceRail(visible);
    return () => {
      syncCadenceRail(false);
    };
  }, [visible]);
}
