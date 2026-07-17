import { useEffect } from 'react';
import { useMutationState, useQueryClient } from '@tanstack/react-query';
import type { Mutation } from '@tanstack/react-query';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useSyncStatusStore } from '@/stores/syncStatusStore';
import { deriveSyncStatus, type SyncStatus } from '@/features/shell/syncStatus';
import { isClientRejection } from '@/lib/apiError';

/** How a pending write is progressing, for the badge modal's list. */
export type PendingWriteState = 'queued' | 'sending' | 'failed';

export interface PendingWrite {
  id: number;
  /** Human label derived from the mutation's meta/key; generic fallback. */
  label: string;
  state: PendingWriteState;
}

/** Minimal, render-stable projection of a mutation for the badge. */
interface MutationSummary {
  id: number;
  status: 'idle' | 'pending' | 'success' | 'error';
  isPaused: boolean;
  label: string;
  error: string | null;
  /**
   * The write was refused by the server with a `4xx` (validation / permission /
   * conflict). Excluded from the offline-pending set: it is not a queued change
   * waiting to drain, and replaying it verbatim would just be rejected again
   * (#1945). The offending surface shows the reason inline instead.
   */
  clientRejected: boolean;
}

function readLabel(mutation: Mutation<unknown, Error, unknown, unknown>): string {
  const meta = mutation.options.meta;
  const metaLabel = meta?.label ?? meta?.description;
  if (typeof metaLabel === 'string' && metaLabel.trim() !== '') return metaLabel;
  const key = mutation.options.mutationKey;
  if (Array.isArray(key) && typeof key[0] === 'string') return key[0];
  return 'Pending change';
}

function readError(mutation: Mutation<unknown, Error, unknown, unknown>): string | null {
  const error = mutation.state.error;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return error ? 'Save failed' : null;
}

const selectSummary = (
  mutation: Mutation<unknown, Error, unknown, unknown>,
): MutationSummary => ({
  id: mutation.mutationId,
  status: mutation.state.status,
  isPaused: mutation.state.isPaused,
  label: readLabel(mutation),
  error: readError(mutation),
  clientRejected: isClientRejection(mutation.state.error),
});

export interface SyncStatusView {
  status: SyncStatus;
  /** Writes not yet confirmed by the server (in-flight, paused, or failed). */
  pendingWrites: PendingWrite[];
  /** Message of the most recent errored write, if any. */
  lastError: string | null;
  lastSyncAt: number | null;
  /** Highest backlog observed this drain — denominator for drain progress. */
  pendingPeak: number;
}

/**
 * Derive the SyncStatusBadge view from live client state (ADR-0205): browser
 * connectivity, the TanStack Query mutation cache, and the session sync store.
 * No backend call — the pending-write queue is inherently client-side.
 */
export function useSyncStatus(): SyncStatusView {
  const online = useOnlineStatus();
  const lastSyncAt = useSyncStatusStore((s) => s.lastSyncAt);
  const pendingPeak = useSyncStatusStore((s) => s.pendingPeak);
  const reportPending = useSyncStatusStore((s) => s.reportPending);

  // Re-renders whenever the mutation cache changes (add/settle/pause/error).
  const mutations = useMutationState({ select: selectSummary });

  let inFlightCount = 0;
  let pausedCount = 0;
  let errorCount = 0;
  let lastError: string | null = null;
  const pendingWrites: PendingWrite[] = [];

  for (const m of mutations) {
    // A 4xx client rejection is surfaced inline on the offending surface, never
    // through the global sync badge — skip it entirely (#1945).
    if (m.clientRejected) continue;
    if (m.status === 'error') {
      errorCount += 1;
      lastError = m.error;
      pendingWrites.push({ id: m.id, label: m.label, state: 'failed' });
    } else if (m.status === 'pending') {
      if (m.isPaused) {
        pausedCount += 1;
        pendingWrites.push({ id: m.id, label: m.label, state: 'queued' });
      } else {
        inFlightCount += 1;
        pendingWrites.push({ id: m.id, label: m.label, state: 'sending' });
      }
    }
  }

  const outstanding = inFlightCount + pausedCount + errorCount;
  // Track the drain peak so the modal can render determinate progress. Kept in an
  // effect (not during render) so the store update never fires mid-render.
  useEffect(() => {
    reportPending(outstanding);
  }, [outstanding, reportPending]);

  const status = deriveSyncStatus({
    online,
    inFlightCount,
    pausedCount,
    errorCount,
    lastError,
    lastSyncAt,
  });

  return { status, pendingWrites, lastError, lastSyncAt, pendingPeak };
}

/**
 * Count of un-drained writes that a tab close / reload would lose (#2028):
 * paused (offline-queued) and in-flight mutations. Excludes 4xx client
 * rejections — those are surfaced inline and never retried, so they're not
 * pending work at risk. Drives the {@link PendingWritesGuard} beforeunload
 * prompt. Cheap projection so it re-renders only on cache add/settle/pause.
 */
export function usePendingWriteCount(): number {
  const mutations = useMutationState({
    select: (m) => ({
      status: m.state.status,
      isPaused: m.state.isPaused,
      clientRejected: isClientRejection(m.state.error),
    }),
  });
  let count = 0;
  for (const m of mutations) {
    if (m.clientRejected) continue;
    // `pending` covers both paused (offline-queued) and in-flight writes.
    if (m.status === 'pending') count += 1;
  }
  return count;
}

/**
 * Manually drain the write queue: resume any offline-paused mutations and re-run
 * any that errored. Idempotent — resuming with nothing paused is a no-op and an
 * already-running mutation is not re-enqueued (ADR-0205).
 */
export function useRetrySync(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.resumePausedMutations();
    const errored = queryClient
      .getMutationCache()
      .getAll()
      // Never blindly replay a 4xx client rejection — the server already
      // refused it and would refuse it again; it re-validates when the user
      // edits and re-submits the offending value instead (#1945).
      .filter((m) => m.state.status === 'error' && !isClientRejection(m.state.error));
    await Promise.allSettled(errored.map((m) => m.continue()));
  };
}
