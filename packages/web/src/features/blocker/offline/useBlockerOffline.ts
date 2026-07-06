/**
 * Offline blocker orchestration (ADR-0247): optimistic offline enqueue and the
 * mount-independent reconnect flush with server field-merge conflict handling.
 *
 * This is the glue between the durable queue (`blockerQueue.ts`), the reactive
 * mirror (`blockerOutboxStore.ts`), and the task TanStack Query cache. Unlike the
 * board's `useBoardOffline` (mounted only by `BoardView`), the flush is owned by
 * `useBlockerOffline`, mounted once in `AppShell` — so a queued blocker syncs on
 * reconnect even if the user never reopens the blocker drawer or the board.
 */
import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { apiClient } from '@/api/client';
import { handleSyncConflict } from '@/api/conflict';
import type { Task } from '@/types';
import { useBlockerOutboxStore } from './blockerOutboxStore';
import {
  buildBlockerPatchBody,
  collapseLatestPerTask,
  optimisticBlockerPatch,
  type BlockerVars,
} from './blockerQueue';

const tasksKey = (projectId: string) => ['tasks', projectId] as const;

/**
 * Queue a blocker write made while offline: apply the optimistic patch to the
 * cached task list (so the flag/unblock shows immediately) and persist the op to
 * the durable queue (so it survives a reload and flushes on reconnect).
 *
 * The task's current `serverVersion` is snapshotted as the op's base so the
 * flush can opt into ADR-0217 field-level merge; `wasFlagged` records whether an
 * age already exists so the UI can render "queued" for a fresh flag.
 */
export function queueOfflineBlocker(client: QueryClient, vars: BlockerVars): void {
  const key = tasksKey(vars.projectId);
  const tasks = client.getQueryData<Task[]>(key);
  const current = tasks?.find((t) => t.id === vars.taskId);
  const wasFlagged = current?.blockedAgeSeconds != null;
  const patch = optimisticBlockerPatch(vars, wasFlagged);
  client.setQueryData<Task[]>(key, (old) =>
    old ? old.map((t) => (t.id === vars.taskId ? { ...t, ...patch } : t)) : old,
  );
  void useBlockerOutboxStore.getState().enqueue({
    ...vars,
    baseServerVersion: current?.serverVersion ?? null,
    wasFlagged,
    queuedAt: Date.now(),
  });
}

/**
 * Replay every queued blocker write against the server, honoring last-write-wins
 * with server field-level merge (ADR-0217).
 *
 * Each op replays the identical PATCH the online path uses, carrying its
 * `baseServerVersion` as `X-Base-Version`: the server merges a disjoint concurrent
 * edit and only 409s when the *blocker fields themselves* were changed under us.
 * On that conflict we yield to the server (drop the op, refetch, calm conflict
 * toast). A transient failure leaves the op queued for the next reconnect flush —
 * never a silent drop.
 */
export async function flushBlockerOutbox(client: QueryClient): Promise<void> {
  const store = useBlockerOutboxStore.getState();
  const ops = collapseLatestPerTask(Object.values(store.opsByTask)).sort(
    (a, b) => a.queuedAt - b.queuedAt,
  );
  if (ops.length === 0) return;

  const affectedProjects = new Set<string>();
  for (const op of ops) {
    affectedProjects.add(op.projectId);
    try {
      const config =
        op.baseServerVersion != null
          ? { headers: { 'X-Base-Version': String(op.baseServerVersion) } }
          : undefined;
      await apiClient.patch(`/tasks/${op.taskId}/`, buildBlockerPatchBody(op), config);
      await store.remove(op.taskId);
      store.markSynced(op.taskId);
    } catch (err) {
      // Overlapping blocker-field edit landed while we were offline: yield to the
      // server (ADR-0217/0247). Show the conflict toast + refetch, then drop the op.
      const wasConflict = handleSyncConflict(err, () => {
        void client.invalidateQueries({ queryKey: tasksKey(op.projectId) });
      });
      if (wasConflict) await store.remove(op.taskId);
      // Non-conflict (transient/offline) error: keep the op for the next flush.
    }
  }

  // Reconcile server-authoritative fields (real blocked_since/age, server_version).
  for (const projectId of affectedProjects) {
    void client.invalidateQueries({ queryKey: tasksKey(projectId) });
  }
}

/**
 * Wire the app into the blocker-offline subsystem: hydrate the durable queue into
 * the reactive mirror, flush any queued writes immediately if we mount online, and
 * flush again whenever the browser reconnects.
 *
 * Call once, from `AppShell` — it owns the global `online` wiring so a queued
 * blocker is not stranded when the originating drawer/board is unmounted.
 */
export function useBlockerOffline(): void {
  useEffect(() => {
    void useBlockerOutboxStore
      .getState()
      .hydrate()
      .then(() => {
        if (typeof navigator === 'undefined' || navigator.onLine) {
          void flushBlockerOutbox(queryClient);
        }
      });
    const onOnline = () => void flushBlockerOutbox(queryClient);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);
}
