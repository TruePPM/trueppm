/**
 * Reactive mirror of the offline blocker-write queue (ADR-0247).
 *
 * IndexedDB (`blockerQueue.ts`) is the durable source of truth, but IndexedDB
 * reads are async and do not trigger React re-renders. This Zustand store is the
 * in-memory, synchronous projection that `BlockerSection` subscribes to for the
 * "will sync when online" badge. Every mutation writes through to IndexedDB so the
 * two never diverge; on load the store hydrates from IndexedDB so writes queued
 * before a reload reappear.
 *
 * `lastSynced` is a transient success signal: the reconnect flush sets it only on
 * a successful replay (never on a 409 yield), so a mounted `BlockerSection` can
 * announce "Blocker synced" without mistaking a conflict for a success.
 */
import { create } from 'zustand';
import {
  deleteQueuedBlockerOp,
  getAllQueuedBlockerOps,
  putQueuedBlockerOp,
  type QueuedBlockerOp,
} from './blockerQueue';

interface BlockerOutboxState {
  /** Queued writes keyed by task id — one per task (last-write-wins). */
  opsByTask: Record<string, QueuedBlockerOp>;
  /** True once the initial IndexedDB hydration has completed. */
  hydrated: boolean;
  /** Set on a successful flush replay (never on conflict) — drives the "synced" announcement. */
  lastSynced: { taskId: string; at: number } | null;
  /** Load persisted ops from IndexedDB into memory (idempotent, call once on mount). */
  hydrate: () => Promise<void>;
  /** Queue (or overwrite) a write for a task; writes through to IndexedDB. */
  enqueue: (op: QueuedBlockerOp) => Promise<void>;
  /** Remove a task's queued write; writes through to IndexedDB. */
  remove: (taskId: string) => Promise<void>;
  /** Signal a successful sync for a task (transient; consumed by the drawer). */
  markSynced: (taskId: string) => void;
}

export const useBlockerOutboxStore = create<BlockerOutboxState>((set, get) => ({
  opsByTask: {},
  hydrated: false,
  lastSynced: null,

  hydrate: async () => {
    if (get().hydrated) return;
    const ops = await getAllQueuedBlockerOps();
    const opsByTask: Record<string, QueuedBlockerOp> = {};
    for (const op of ops) opsByTask[op.taskId] = op;
    set({ opsByTask, hydrated: true });
  },

  enqueue: async (op) => {
    // Update the reactive mirror first so the badge appears instantly, then
    // persist — a failed IndexedDB write must not block the optimistic UI.
    set((s) => ({ opsByTask: { ...s.opsByTask, [op.taskId]: op } }));
    await putQueuedBlockerOp(op);
  },

  remove: async (taskId) => {
    set((s) => {
      if (!(taskId in s.opsByTask)) return s;
      const next = { ...s.opsByTask };
      delete next[taskId];
      return { opsByTask: next };
    });
    await deleteQueuedBlockerOp(taskId);
  },

  markSynced: (taskId) => set({ lastSynced: { taskId, at: Date.now() } }),
}));

/**
 * Subscribe to a single task's queued blocker write (or `undefined`).
 *
 * Selector-scoped so a drawer only re-renders when *its own* task's pending state
 * changes, not on every queue mutation.
 */
export function useBlockerPendingOp(taskId: string): QueuedBlockerOp | undefined {
  return useBlockerOutboxStore((s) => s.opsByTask[taskId]);
}

/**
 * The epoch-ms timestamp of the last successful sync for `taskId`, or `null`.
 *
 * A change in this value (for the drawer's task) is the cue to announce "Blocker
 * synced" via the live region — driven off flush success only, so a 409 yield
 * (which shows its own conflict toast) never triggers a false success message.
 */
export function useBlockerSyncedSignal(taskId: string): number | null {
  return useBlockerOutboxStore((s) => (s.lastSynced?.taskId === taskId ? s.lastSynced.at : null));
}
