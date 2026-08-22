import { useIsCoarsePointer } from './useIsCoarsePointer';
import {
  syncRowMetrics,
  resolveBarTopOffset,
  resolveGripWidth,
  resolveGripReserve,
} from '@/features/schedule/scheduleConstants';

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
  return syncRowMetrics(coarse);
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
  const rowHeight = syncRowMetrics(coarse);
  return {
    rowHeight,
    barTopOffset: resolveBarTopOffset(rowHeight),
    gripWidth: resolveGripWidth(coarse),
    gripReserve: resolveGripReserve(coarse),
    coarse,
  };
}
