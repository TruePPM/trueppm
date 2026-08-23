import { useEffect, useSyncExternalStore } from 'react';
import { useIsCoarsePointer } from './useIsCoarsePointer';
import {
  syncRowMetrics,
  syncComfortableRows,
  getComfortableRows,
  subscribeComfortableRows,
  resolveBarTopOffset,
  resolveGripWidth,
  resolveGripReserve,
} from '@/features/schedule/scheduleConstants';

/** SSR has no preference to read — the leaner default, same as the store's. */
function getComfortableRowsServerSnapshot(): boolean {
  return false;
}

/**
 * Subscribe to the Comfortable-rows input without re-deriving anything from it.
 *
 * The *resolution* stays in `scheduleConstants`; this only turns a change in the
 * preference into a re-render, so `syncRowMetrics()` below is re-run and returns
 * the new height. A hook that read the flag and computed `comfortable ? 44 : 28`
 * would be the second definition web rule 315 forbids.
 */
function useComfortableRowsSubscription(): boolean {
  return useSyncExternalStore(
    subscribeComfortableRows,
    getComfortableRows,
    getComfortableRowsServerSnapshot,
  );
}

/**
 * The Schedule row height for the current pointer class — 28px on a mouse,
 * 44px on a coarse pointer (#2997).
 *
 * Two jobs, and both matter:
 *
 * 1. **Subscribe.** A React consumer that merely reads the `ROW_HEIGHT` live
 *    binding gets the right number but never re-renders when the pointer class
 *    flips — a tablet gaining a keyboard, a hybrid laptop folding shut. This
 *    hook holds the media-query subscription that makes the flip a render.
 * 2. **Return what the engine has, not a parallel calculation.** It returns the
 *    value `syncRowMetrics` just installed, so the DOM outline and the canvas
 *    cannot resolve two different heights inside one commit. A hook that
 *    computed `coarse ? 44 : 28` itself would be the second definition this
 *    whole change exists to delete.
 *
 * `syncRowMetrics` is idempotent in its argument, so calling it during render is
 * safe under strict mode's double render — it installs the same value twice.
 */
export function useRowHeight(): number {
  const coarse = useIsCoarsePointer();
  useComfortableRowsSubscription();
  return syncRowMetrics(coarse);
}

/**
 * Install the Schedule's **Comfortable rows** preference into the row model
 * (#3019).
 *
 * Called by the one component that owns the preference (`ScheduleView`, from
 * `useScheduleDisplayOptions`). Everybody else *reads* the resolved height
 * through `useRowHeight()` / `useRowMetrics()` and never sees the flag — which
 * is the point: the option is a second **input** to the single owner, not a
 * second row-height source that each consumer has to remember to consult. Before
 * this hook the toggle persisted to localStorage and was read by nothing at all.
 *
 * Written from an effect rather than during render because the value arrives
 * from an async localStorage hydration and because `syncComfortableRows` notifies
 * subscribers — notifying during another component's render is the "cannot update
 * a component while rendering a different component" warning.
 *
 * The cleanup resets the input, so leaving the Schedule cannot leave a stale
 * `true` latched for an unrelated surface that also reads the row model (the
 * program schedule page, which has no Display menu of its own).
 */
export function useComfortableRows(enabled: boolean): void {
  useEffect(() => {
    syncComfortableRows(enabled);
    return () => {
      syncComfortableRows(false);
    };
  }, [enabled]);
}

/**
 * Row height plus the geometry derived from it, for the components that need
 * more than the height alone (the bar inset, the grip's touch reserve).
 *
 * One hook rather than three so a consumer cannot pick up a row height from one
 * render and a bar inset from another.
 */
export function useRowMetrics(): {
  rowHeight: number;
  barTopOffset: number;
  gripWidth: number;
  gripReserve: number;
  coarse: boolean;
} {
  const coarse = useIsCoarsePointer();
  useComfortableRowsSubscription();
  const rowHeight = syncRowMetrics(coarse);
  return {
    rowHeight,
    barTopOffset: resolveBarTopOffset(rowHeight),
    // The grip's *lane* stays keyed on the pointer class, not on the resolved
    // height, and that is deliberate rather than an oversight. `gripWidth` and
    // `gripReserve` answer a different question — *can this pointer aim?* — and
    // their 44px answer exists because a finger cannot hit a 14px target
    // (WCAG 2.5.5), not because the row is tall. The lane is also binary (0 or
    // 44, see `resolveGripReserve`), so the only alternative is surrendering a
    // fifth of the name column at the Timeline's ~268px outline to an affordance
    // that is `opacity-0` until hover and `aria-hidden` throughout. A mouse user
    // can still aim and still has hover, so they lose nothing.
    //
    // What DOES follow the resolved height is everything sized from `rowHeight`:
    // the grip's own height, the row box, the append footer, the draft row, the
    // overlay rects and the canvas bands. That list is exhaustive, and stating
    // it as "every control" would be false — the `+` insert disc and the WBS
    // ⇤/⇥ nudges are fixed 16px marks whose 44px hit box is expanded (for the
    // disc) or absent (for the nudges) on the pointer class. Widening those at a
    // fine pointer is NOT a free change: the disc is invisible until hover, so a
    // 44px `before:` box around it would put an unseen z-10 click target over
    // the row's own name cell. It needs a visibility decision, not a predicate
    // swap — tracked separately rather than smuggled in here.
    gripWidth: resolveGripWidth(coarse),
    gripReserve: resolveGripReserve(coarse),
    coarse,
  };
}
