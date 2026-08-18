/**
 * Session trail for structural acts on the outline (#2948, epic #2946).
 *
 * Undo on this surface was a keystroke with **nothing to inspect**: a user who
 * indented the wrong row and then made three more edits had no way to see what
 * had happened. That is a lot of trust to ask for from gestures that move and
 * delete whole subtrees. The trail is the record — newest first, capped, and
 * scoped to the session that made it.
 *
 * A store rather than component state for the same reason as `reconcileStore`:
 * the trail must survive a tab switch between Grid and Timeline, which unmounts
 * the outline. It is deliberately **not** persisted — a trail restored from
 * localStorage would assert acts from a session whose context is gone, and the
 * word "this session" would be a lie.
 *
 * Scoped per project so switching projects does not show someone else's plan's
 * history.
 */
import { create } from 'zustand';

/** Entries older than this fall off the end; the trail is a recent-history view. */
export const TRAIL_CAP = 10;

export interface TrailEntry {
  id: number;
  /** The same sentence the live region announced. */
  text: string;
  /** Wall-clock, for the `14:32` stamp in the popover. */
  at: Date;
}

interface TrailState {
  projectId: string | null;
  entries: TrailEntry[];
  record: (projectId: string, text: string) => void;
  clear: () => void;
}

let seq = 0;

export const useTrailStore = create<TrailState>((set) => ({
  projectId: null,
  entries: [],
  record: (projectId, text) =>
    set((s) => {
      // A project switch resets rather than appends: "3 changes this session"
      // must never count acts performed on a different plan.
      const base = s.projectId === projectId ? s.entries : [];
      const next = [...base, { id: ++seq, text, at: new Date() }];
      return {
        projectId,
        entries: next.length > TRAIL_CAP ? next.slice(next.length - TRAIL_CAP) : next,
      };
    }),
  clear: () => set({ projectId: null, entries: [] }),
}));
