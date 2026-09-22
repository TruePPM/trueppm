import { create } from 'zustand';
import { isDemoReadOnlyRefusal } from '@/lib/demoReadOnly';
import { isDemoReadOnlySync } from '@/hooks/useDemoMode';
import type { Task, TaskStatus } from '@/types';

/**
 * The read-only demo's preview overlay (ADR-1197 D4, #3926).
 *
 * The demo's headline is *drag a task and watch the critical path recompute; nothing
 * is saved*. The commit PATCH is refused by design — and a bar that snaps back on that
 * refusal reads as a bug, destroying exactly the impression the mode exists to create.
 * So the dropped position has to outlive the refusal.
 *
 * **Why a store and not the query cache.** Three separate things reset a value held in
 * the cache, and the overlay must survive all three: the mutation's own `onError`
 * rollback, `useScheduleTasks`' 30 s fallback refetch (live here, because `/ws/` is
 * closed in this mode per D1), and SPA navigation. Only a layer *above* the cache
 * survives them — and keeping it above also keeps the cache truthful about what the
 * server actually holds.
 *
 * **What persists, stated honestly.** The dragged bar's own dates, and — since ADR-1198
 * (#3967) — the board card's own status. The downstream cascade a visitor watches during
 * the drag comes from `dragStore.previewResults`, which is capped and clears on release;
 * replaying a partial cascade afterwards would be a worse lie than one stable bar. The
 * same reasoning bounds the board: the *sprint burndown and velocity are server-computed
 * snapshot series and deliberately do not react*, because a line derived in the browser
 * from a task list that carries no history would disagree with the sprint panel beside
 * it. Both limits are deliberate.
 *
 * In-memory only — a full page reload clears it, which is the mode's own reset and the
 * reason nothing here touches `sessionStorage`.
 */
export interface DemoOverlayEntry {
  start?: string;
  finish?: string;
  duration?: number;
  /**
   * The board column the visitor dropped the card in (ADR-1198).
   *
   * Status and status alone — never `parentId`, `sprintId` or `boardLane`, which
   * `optimisticStatusPatch` also carries. Those three move a card between *collections*,
   * and the rule `applyDemoOverlay` states below (value fields only) is what keeps the
   * overlay from having to answer what a sprint the server says the card is not in
   * should count, points and all. That would be a second source of truth wearing a
   * preview's clothes, which is what ADR-0599 forbids.
   */
  status?: TaskStatus;
}

/**
 * Entries kept before the oldest is evicted. A visitor cannot meaningfully hold two
 * hundred dragged bars in their head, and the map is insertion-ordered, so FIFO drops
 * the one furthest from what they are currently looking at.
 */
export const DEMO_OVERLAY_CAP = 200;

interface DemoOverlayState {
  /** taskId → the dates the visitor dropped the bar at. Insertion-ordered. */
  entries: Map<string, DemoOverlayEntry>;
  /** Record (or replace) one task's dropped position. Last write wins. */
  set: (taskId: string, entry: DemoOverlayEntry) => void;
  clear: () => void;
}

export const useDemoOverlayStore = create<DemoOverlayState>((set) => ({
  entries: new Map(),
  set: (taskId, entry) =>
    set((s) => {
      const next = new Map(s.entries);
      // Delete first so a repeat drag of the same bar re-enters at the END of the
      // insertion order: it is the most recent thing the visitor did, and evicting it
      // before an older, untouched bar would be backwards.
      next.delete(taskId);
      next.set(taskId, entry);
      while (next.size > DEMO_OVERLAY_CAP) {
        const oldest = next.keys().next();
        if (oldest.done) break;
        next.delete(oldest.value);
      }
      return { entries: next };
    }),
  clear: () => set({ entries: new Map() }),
}));

/**
 * Lay the overlay over a fetched task list.
 *
 * Applied to **value fields only** (`start` / `finish` / `duration` / `status`) and never
 * to identity, parentage or array order: the WBS codes a row renders are computed from
 * sibling *index*, so an overlay that could reorder rows would renumber the outline
 * under the visitor. It also short-circuits on an empty map, which is every normal
 * install — the cost there is one `size` read per render.
 *
 * `status` deliberately does NOT drag `progress` / `isComplete` along with it, even
 * though a DONE column implies both. `optimisticStatusPatch` — the client's own standing
 * belief about what a status move changes — carries status and nothing else, and the
 * server is what fills the rest in on a real install. Fabricating them here would make
 * the demo's board the only surface in the product that computes a completion percentage
 * without one.
 */
export function applyDemoOverlay(
  tasks: Task[] | undefined,
  overlay: Map<string, DemoOverlayEntry>,
): Task[] | undefined {
  if (!tasks || overlay.size === 0) return tasks;
  return tasks.map((t) => {
    const entry = overlay.get(t.id);
    if (!entry) return t;
    return {
      ...t,
      ...(entry.start !== undefined ? { start: entry.start } : {}),
      ...(entry.finish !== undefined ? { finish: entry.finish } : {}),
      ...(entry.duration !== undefined ? { duration: entry.duration } : {}),
      ...(entry.status !== undefined ? { status: entry.status } : {}),
    };
  });
}

/**
 * Route a refused write into the preview overlay, or decline to (ADR-1197 D4, ADR-1198).
 *
 * The single gate for every capture site — the Schedule's date paths in
 * `useTaskMutations` and the board's status move in `useBoardTasks`. Shared rather than
 * re-written per caller because it is the *gate* that has to not drift: a second copy
 * that checked one fact instead of two would be invisible until a real install
 * fabricated state the server does not hold.
 *
 * Gated on **both** facts, never on the refusal code alone: `isDemoReadOnlySync()` says
 * this deployment really is the demo, and `isDemoReadOnlyRefusal(err)` says this
 * particular 403 is the mode's own. Without the first, a mislabeled 403 on a real
 * install could fabricate a schedule — or a board — the server never agreed to.
 * An unresolved `['edition']` cache reads as `false`, which is the safe default.
 *
 * Returns true when it captured, so the caller can skip whatever it would otherwise do
 * with a failure — a rejection strip with a Retry that can never succeed, or a red
 * "try again" toast for an action the server will refuse every time.
 */
export function captureDemoOverlayEntry(
  err: unknown,
  taskId: string,
  entry: DemoOverlayEntry,
): boolean {
  if (!isDemoReadOnlySync() || !isDemoReadOnlyRefusal(err)) return false;
  // An entry with nothing in it would pin a no-op into the map and, worse, report
  // `true` — telling the caller a preview is on screen when none is.
  if (
    entry.start === undefined &&
    entry.finish === undefined &&
    entry.duration === undefined &&
    entry.status === undefined
  ) {
    return false;
  }
  useDemoOverlayStore.getState().set(taskId, entry);
  return true;
}
