/**
 * The client-side mirror of the server's "this task is out of network logic"
 * verdict (ADR-0132, issue #2819).
 *
 * Both server engines take a task that is complete AND carries a recorded
 * actual out of the CPM network entirely (`_pinned_placement` in the Python
 * engine, `pinned_placement` in the Rust/WASM one): its dates come from its
 * actuals, and `planned_start` is never consulted for it. The browser preview
 * engine already agrees — `cpmEngine.ts` computes the same predicate as
 * `isPinned` and refuses to move such a task or cascade from it (#2813).
 *
 * What #2813 deliberately left open is that the *gesture* never learned the
 * verdict. The Gantt still offers move and resize on a pinned bar, the API
 * still accepts the PATCH, `_sync_early_start_to_planned` moves `early_start`
 * optimistically so the bar visibly lands at the drop — and then the CPM run
 * re-pins it to its actuals and the bar snaps back with nothing saying why.
 *
 * This module is the one place that verdict and its explanation live, so the
 * drag chrome and the screen-reader announcement cannot drift apart.
 *
 * Deliberately NOT keyed on `isComplete` alone: pinning is conditional on
 * recorded actuals. A task complete by `progress` with no actuals IS still
 * network-scheduled and must stay fully draggable — a blanket completion gate
 * would take a working interaction away from it.
 */

import type { Task } from '@/types';

/**
 * True when recorded actuals — not the network — set this task's dates.
 *
 * Mirrors `cpmEngine.ts`'s `isPinned`, which in turn mirrors the server's
 * `_pinned_placement`. Keep the three in step: a divergence shows up as a bar
 * that previews one placement and commits another.
 */
export function isPinnedByActuals(task: Pick<Task, 'isComplete' | 'actualStart' | 'actualFinish'>): boolean {
  return task.isComplete && (task.actualStart != null || task.actualFinish != null);
}

/**
 * The single sentence both the preview chrome and the aria-live region use.
 *
 * One string, one source: web rule 291's corollary — two surfaces printing one
 * server fact must share one formatter, or they drift the moment either is
 * edited.
 */
export const PINNED_DRAG_EXPLANATION =
  "Recorded actuals set this task's dates — the drop won't move it";

/**
 * The same verdict, phrased for the keyboard path (#2827).
 *
 * The drag sentence above names a gesture the keyboard user never performed —
 * there is no drop to speak of when `r` is refused outright — so the two paths
 * need two sentences. They stay in this one module rather than at their call
 * sites for the reason above: the *reason* must not drift even when the wording
 * differs, and a call site that hand-rolls its own phrasing is how it does.
 */
export const PINNED_KEYBOARD_REFUSAL =
  "Recorded actuals set this task's dates — it can't be rescheduled. Change its actual dates instead.";
