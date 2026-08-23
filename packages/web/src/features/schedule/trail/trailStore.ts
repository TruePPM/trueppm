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
  /**
   * Server ledger handle for `POST /structural-operations/{id}/undo/` (ADR-0880).
   *
   * Absent on acts this tree cannot reverse — duplicate, convert-to-milestone and
   * single-row insert have no ledger row, and delete keeps its own restore path. An
   * entry without one renders as a record with no control, which is the whole point:
   * the trail must never offer an Undo it cannot honour (#2974).
   */
  operationId?: string;
  /** Set once its undo succeeds, so the entry reads as spent rather than vanishing. */
  undone?: boolean;
}

interface TrailState {
  projectId: string | null;
  entries: TrailEntry[];
  /** Returns the new entry's id so a caller can attach a ledger handle later. */
  record: (projectId: string, text: string, operationId?: string) => number;
  /** Late-bind a ledger handle once the mutation that earned it has responded. */
  attachOperation: (entryId: number, operationId: string | null) => void;
  markUndone: (entryId: number) => void;
  clear: () => void;
}

let seq = 0;

export const useTrailStore = create<TrailState>((set) => ({
  projectId: null,
  entries: [],
  record: (projectId, text, operationId) => {
    // The id is minted here rather than inside `set` so it can be returned: the
    // structural endpoints only reveal their `operation_id` when they respond, which
    // is after the sentence has already been announced and recorded.
    const id = ++seq;
    set((s) => {
      // A project switch resets rather than appends: "3 changes this session"
      // must never count acts performed on a different plan.
      const base = s.projectId === projectId ? s.entries : [];
      const next = [...base, { id, text, at: new Date(), operationId }];
      return {
        projectId,
        entries: next.length > TRAIL_CAP ? next.slice(next.length - TRAIL_CAP) : next,
      };
    });
    return id;
  },
  attachOperation: (entryId, operationId) =>
    set((s) => ({
      entries: operationId
        ? s.entries.map((e) => (e.id === entryId ? { ...e, operationId } : e))
        : s.entries,
    })),
  markUndone: (entryId) =>
    set((s) => ({
      entries: s.entries.map((e) => (e.id === entryId ? { ...e, undone: true } : e)),
    })),
  clear: () => set({ projectId: null, entries: [] }),
}));

/**
 * The one entry ⌘Z would reverse right now, or `null`.
 *
 * Rule 316's single derivation: the popover's Undo button and the ⌘Z keybinding both
 * read this, so the control and the keystroke cannot disagree about their target. A
 * hand-maintained second copy of "which one is undoable" would drift in the worst
 * direction — a confident wrong answer gets acted on.
 *
 * Only the newest reversible entry is offered, matching the server, which refuses an
 * out-of-order undo with `not_top_of_stack`. Undoing it makes the next one newest, so
 * repeated ⌘Z walks back through the trail one safe step at a time.
 */
export function newestUndoableEntry(entries: TrailEntry[]): TrailEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.undone) continue;
    // An entry with no ledger handle is an act this tree cannot reverse. It does not
    // just fail to be the target — it blocks the ones behind it, because undoing an
    // older act while a newer unreversible one sits on top would leave the outline in
    // a state the user never produced.
    return entry.operationId ? entry : null;
  }
  return null;
}
