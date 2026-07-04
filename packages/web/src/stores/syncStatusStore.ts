/**
 * Session-scoped sync-status state that the TanStack Query mutation cache can't
 * express on its own (ADR-0205): the last time a write successfully reached the
 * server, and the peak size of the current drain so the SyncStatusBadge modal can
 * show determinate "X of Y" progress.
 *
 * TruePPM is offline-default, so a truthful write-sync signal — not a permanently
 * "saved" claim — is the point. This store is deliberately in-memory: `lastSyncAt`
 * is a session trust signal, not durable state, so it resets on reload (a fresh
 * session has genuinely not synced yet).
 */
import { create } from 'zustand';

interface SyncStatusStoreState {
  /** Epoch ms of the last successful mutation, or null if none this session. */
  lastSyncAt: number | null;
  /**
   * Highest pending-write count observed during the current drain. Reset to 0
   * when the queue empties, so drain progress is measured from the peak backlog
   * to zero rather than from an arbitrary mid-drain snapshot.
   */
  pendingPeak: number;
  /** Bump `lastSyncAt` — called from the global MutationCache `onSuccess`. */
  markSynced: () => void;
  /**
   * Report the current pending-write count. Grows `pendingPeak` monotonically
   * while writes are outstanding and resets it once the queue drains to empty.
   */
  reportPending: (count: number) => void;
}

export const useSyncStatusStore = create<SyncStatusStoreState>()((set) => ({
  lastSyncAt: null,
  pendingPeak: 0,

  markSynced: () => set({ lastSyncAt: Date.now() }),

  reportPending: (count) =>
    set((s) => ({
      pendingPeak: count === 0 ? 0 : Math.max(s.pendingPeak, count),
    })),
}));
