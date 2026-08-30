import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ScheduleAuthorMode } from './useScheduleAuthorMode';
import type { ScheduleViewMode } from '@/stores/scheduleStore';

export interface AuthorModeLayoutCouplingParams {
  /** Current Author/Read mode. */
  authorMode: ScheduleAuthorMode;
  /** True until the stored Author/Read preference has resolved. */
  isLoading: boolean;
  /** Below `md`, where the layout is forced to Timeline and must not be written. */
  isMobile: boolean;
  /** The *stored* layout — not `resolveEffectiveViewMode`'s mobile override. */
  viewMode: ScheduleViewMode;
  setViewMode: (next: ScheduleViewMode) => void;
}

/**
 * Move the layout with the mode, once, on the transition (#3114).
 *
 * Grid is the layout you author in — the row list, the outline controls, inline
 * field editing and the insert-target affordances all live there. Timeline is
 * the one you read a plan in. Before this the two were fully independent, so a
 * planner reviewing in Timeline who hit `Alt+A` to start editing landed in
 * Author mode *in the reading layout* and had to make a second, manual move to
 * the layout Author mode exists to serve. Leaving had the mirror problem.
 *
 * Three rules, and the third is what keeps this a default rather than a trap:
 *
 * 1. Entering Author switches to Grid, remembering the layout that was active.
 * 2. Returning to Read restores it.
 * 3. **A manual layout choice wins.** If the person picks a layout themselves
 *    while authoring, the remembered value is dropped and the return to Read
 *    leaves their choice alone. The coupling fires on the mode transition only;
 *    it is never a standing override, and it never fights a deliberate act.
 *
 * The memory is deliberately in-session (a ref, not storage). It exists to undo
 * a switch this hook itself made, so it has no meaning once the page that made
 * it is gone — persisting it would let a reload restore a layout the user never
 * saw us leave.
 *
 * Two things it must not do, both load-bearing:
 * - **Nothing on mobile.** `resolveEffectiveViewMode` forces Timeline below `md`
 *   without touching the stored value; writing Grid here would corrupt the
 *   layout the same person sees when they next open a desktop.
 * - **Nothing on mount.** The first settled pass only records where we are.
 *   Otherwise a project opening in its stored Author mode would read as a
 *   transition and overwrite the stored layout on every load.
 */
export function useAuthorModeLayoutCoupling({
  authorMode,
  isLoading,
  isMobile,
  viewMode,
  setViewMode,
}: AuthorModeLayoutCouplingParams): void {
  const prevModeRef = useRef<ScheduleAuthorMode | null>(null);
  const prevViewRef = useRef<ScheduleViewMode | null>(null);
  const rememberedRef = useRef<ScheduleViewMode | null>(null);
  // Marks the one layout change this hook caused, so the "did they choose it?"
  // branch below does not read our own write as the user's.
  const forcingRef = useRef(false);

  useEffect(() => {
    if (isLoading) return;

    const prevMode = prevModeRef.current;
    const prevView = prevViewRef.current;
    prevModeRef.current = authorMode;
    prevViewRef.current = viewMode;

    // First settled pass — establish a baseline, transition against nothing.
    if (prevMode === null) return;

    if (prevMode !== authorMode) {
      // Nothing on mobile: the layout is forced to Timeline for display only,
      // and writing Grid here would corrupt the stored desktop layout.
      if (!isMobile) {
        applyModeTransition(authorMode, viewMode, setViewMode, rememberedRef, forcingRef);
      }
      return;
    }

    // No mode transition. A layout change while authoring is the person's own,
    // unless it is the write we just issued landing.
    if (authorMode === 'author' && prevView !== viewMode) {
      noteLayoutChangeWhileAuthoring(rememberedRef, forcingRef);
    }
  }, [authorMode, isLoading, isMobile, viewMode, setViewMode]);
}

/**
 * Rule 1 and rule 2: entering Author switches to Grid and remembers where we
 * were; returning to Read restores it.
 *
 * `forcing` is set BEFORE `setViewMode` and only when a write actually happens,
 * so the layout-change branch can tell our own write from the user's. Setting it
 * unconditionally would swallow the next genuine manual choice.
 */
function applyModeTransition(
  authorMode: ScheduleAuthorMode,
  viewMode: ScheduleViewMode,
  setViewMode: (next: ScheduleViewMode) => void,
  remembered: MutableRefObject<ScheduleViewMode | null>,
  forcing: MutableRefObject<boolean>,
): void {
  if (authorMode === 'author') {
    remembered.current = viewMode;
    if (viewMode !== 'grid') {
      forcing.current = true;
      setViewMode('grid');
    }
    return;
  }

  const restore = remembered.current;
  remembered.current = null;
  if (restore && restore !== viewMode) setViewMode(restore);
}

/**
 * Rule 3, the one that keeps this a default rather than a trap: a manual layout
 * choice while authoring drops the remembered value, so returning to Read leaves
 * that choice alone.
 *
 * The one exception is the write this hook itself issued landing — that is not
 * the person choosing, so it clears the marker and keeps the memory.
 */
function noteLayoutChangeWhileAuthoring(
  remembered: MutableRefObject<ScheduleViewMode | null>,
  forcing: MutableRefObject<boolean>,
): void {
  if (forcing.current) {
    forcing.current = false;
    return;
  }
  remembered.current = null;
}
