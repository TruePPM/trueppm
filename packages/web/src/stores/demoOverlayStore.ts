import { create } from 'zustand';
import type { Task } from '@/types';

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
 * **What persists, stated honestly.** Only the dragged bar's own dates. The downstream
 * cascade a visitor watches during the drag comes from `dragStore.previewResults`,
 * which is capped and clears on release; replaying a partial cascade afterwards would
 * be a worse lie than one stable bar. That limit is deliberate.
 *
 * In-memory only — a full page reload clears it, which is the mode's own reset and the
 * reason nothing here touches `sessionStorage`.
 */
export interface DemoOverlayEntry {
  start?: string;
  finish?: string;
  duration?: number;
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
 * Applied to **value fields only** (`start` / `finish` / `duration`) and never to
 * identity, parentage or array order: the WBS codes a row renders are computed from
 * sibling *index*, so an overlay that could reorder rows would renumber the outline
 * under the visitor. It also short-circuits on an empty map, which is every normal
 * install — the cost there is one `size` read per render.
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
    };
  });
}
