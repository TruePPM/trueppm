/**
 * Reactive mirror of the board offline write queue (ADR-0220).
 *
 * IndexedDB (`cardStatusQueue.ts`) is the durable source of truth, but IndexedDB
 * reads are async and do not trigger React re-renders. This Zustand store is the
 * in-memory, synchronous projection that board cards subscribe to for the
 * "pending sync" badge. Every mutation writes through to IndexedDB so the two
 * never diverge; on load the store hydrates from IndexedDB so queued moves made
 * before a reload reappear.
 */
import { create } from 'zustand';
import {
  deleteQueuedOp,
  getAllQueuedOps,
  putQueuedOp,
  type QueuedCardStatusOp,
} from './cardStatusQueue';

interface BoardOutboxState {
  /** Queued moves keyed by task id — one per task (last-write-wins). */
  opsByTask: Record<string, QueuedCardStatusOp>;
  /** True once the initial IndexedDB hydration has completed. */
  hydrated: boolean;
  /** Load persisted ops from IndexedDB into memory (idempotent, call once on mount). */
  hydrate: () => Promise<void>;
  /** Queue (or overwrite) a move for a task; writes through to IndexedDB. */
  enqueue: (op: QueuedCardStatusOp) => Promise<void>;
  /** Remove a task's queued move; writes through to IndexedDB. */
  remove: (taskId: string) => Promise<void>;
}

export const useBoardOutboxStore = create<BoardOutboxState>((set, get) => ({
  opsByTask: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const ops = await getAllQueuedOps();
    const opsByTask: Record<string, QueuedCardStatusOp> = {};
    for (const op of ops) opsByTask[op.taskId] = op;
    set({ opsByTask, hydrated: true });
  },

  enqueue: async (op) => {
    // Update the reactive mirror first so the badge appears instantly, then
    // persist — a failed IndexedDB write should not block the optimistic UI.
    set((s) => ({ opsByTask: { ...s.opsByTask, [op.taskId]: op } }));
    await putQueuedOp(op);
  },

  remove: async (taskId) => {
    set((s) => {
      if (!(taskId in s.opsByTask)) return s;
      const next = { ...s.opsByTask };
      delete next[taskId];
      return { opsByTask: next };
    });
    await deleteQueuedOp(taskId);
  },
}));

/**
 * Subscribe to whether a single card has a queued (not-yet-flushed) status move.
 *
 * Selector-scoped so a card only re-renders when *its own* pending state flips,
 * not on every queue change.
 */
export function useIsCardPendingSync(taskId: string): boolean {
  return useBoardOutboxStore((s) => s.opsByTask[taskId] !== undefined);
}
