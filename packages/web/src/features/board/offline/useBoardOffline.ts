/**
 * Board offline orchestration (ADR-0220): optimistic offline enqueue, last-fetch
 * read snapshot, and the reconnect flush with server-version conflict handling.
 *
 * This is the glue between the durable queue (`cardStatusQueue.ts`), the reactive
 * mirror (`boardOutboxStore.ts`), and the board's TanStack Query cache. It is
 * scoped to card-status moves only; every other write keeps ADR-0205's in-memory
 * pause semantics.
 */
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast/toast';
import type { Task, TaskLink } from '@/types';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';
import { useBoardOutboxStore } from './boardOutboxStore';
import {
  buildStatusPatchBody,
  collapseLatestPerTask,
  getBoardSnapshot,
  hasServerAdvanced,
  optimisticStatusPatch,
  putBoardSnapshot,
  type CardStatusVars,
} from './cardStatusQueue';

const tasksKey = (projectId: string) => ['tasks', projectId] as const;
const depsKey = (projectId: string) => ['dependencies', projectId] as const;
const configKey = (projectId: string) => ['boardConfig', projectId] as const;

/**
 * Queue a card-status move made while offline: apply the optimistic patch to the
 * cached task list (so the card moves immediately) and persist the op to the
 * durable queue (so it survives a reload and flushes on reconnect).
 *
 * The task's current `serverVersion` is snapshotted as the op's base so the
 * reconnect flush can tell whether the server changed underneath us.
 */
export function queueOfflineCardStatus(queryClient: QueryClient, vars: CardStatusVars): void {
  const key = tasksKey(vars.projectId);
  const tasks = queryClient.getQueryData<Task[]>(key);
  const current = tasks?.find((t) => t.id === vars.taskId);
  const patch = optimisticStatusPatch(vars);
  queryClient.setQueryData<Task[]>(key, (old) =>
    old ? old.map((t) => (t.id === vars.taskId ? { ...t, ...patch } : t)) : old,
  );
  void useBoardOutboxStore.getState().enqueue({
    ...vars,
    baseServerVersion: current?.serverVersion ?? null,
    queuedAt: Date.now(),
  });
}

/**
 * Replay every queued move for a project against the server, honoring
 * last-write-wins with a server-version conflict guard.
 *
 * We refetch the task list first so we hold the server's *current* version for
 * each task. A task whose server version advanced beyond the queued op's base was
 * edited by someone else while we were offline: we do not clobber it — the
 * refetch has already restored server truth (reverting our optimistic move) and
 * we surface a calm conflict toast. Non-conflicting ops replay the identical
 * PATCH the online path uses.
 */
export async function flushBoardOutbox(queryClient: QueryClient, projectId: string): Promise<void> {
  const store = useBoardOutboxStore.getState();
  const ops = collapseLatestPerTask(
    Object.values(store.opsByTask).filter((o) => o.projectId === projectId),
  ).sort((a, b) => a.queuedAt - b.queuedAt);
  if (ops.length === 0) return;

  // Learn the server's current state (and versions) before replaying.
  await queryClient.refetchQueries({ queryKey: tasksKey(projectId) });
  const serverTasks = queryClient.getQueryData<Task[]>(tasksKey(projectId));

  for (const op of ops) {
    const serverTask = serverTasks?.find((t) => t.id === op.taskId);
    const currentVersion = serverTask?.serverVersion ?? null;

    if (hasServerAdvanced(op.baseServerVersion, currentVersion)) {
      // Server changed under us while offline. Yield: the refetch already reverted
      // our optimistic move to server truth; tell the user honestly, don't retry.
      const name = serverTask?.name ?? 'A card';
      toast.info(
        `"${name}" changed on the server while you were offline — your move was reverted to the latest.`,
      );
      await store.remove(op.taskId);
      continue;
    }

    try {
      await apiClient.patch(`/tasks/${op.taskId}/`, buildStatusPatchBody(op));
      await store.remove(op.taskId);
    } catch {
      // Terminal replay failure: surface the same message the online path uses and
      // drop the op — the end-of-flush invalidation reconciles the card to server
      // truth rather than leaving a stuck pending badge.
      toast.error("Couldn't move the card — try again.");
      await store.remove(op.taskId);
    }
  }

  await queryClient.invalidateQueries({ queryKey: tasksKey(projectId) });
}

/**
 * Wire a board view into the offline subsystem: hydrate the queue, seed the board
 * from the last cached fetch when opened offline, persist fresh fetches for next
 * time, and flush queued moves whenever the browser reconnects.
 *
 * Call once per mounted board (it owns global `online` wiring for `projectId`).
 */
export function useBoardOffline(projectId: string | null | undefined): void {
  const queryClient = useQueryClient();
  const hydrate = useBoardOutboxStore((s) => s.hydrate);

  // Hydrate the durable queue into the reactive mirror once.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Seed the board from the last successful fetch when we open it offline with an
  // empty cache (criterion 1). Bounded to the first-fetch-missing case so a live
  // cache is never overwritten with stale snapshot data.
  useEffect(() => {
    if (!projectId) return;
    if (typeof navigator !== 'undefined' && navigator.onLine) return;
    if (queryClient.getQueryData<Task[]>(tasksKey(projectId))) return;
    let cancelled = false;
    void getBoardSnapshot(projectId).then((snapshot) => {
      if (cancelled || !snapshot) return;
      if (queryClient.getQueryData<Task[]>(tasksKey(projectId))) return;
      queryClient.setQueryData<Task[]>(tasksKey(projectId), snapshot.tasks);
      queryClient.setQueryData<TaskLink[]>(depsKey(projectId), snapshot.dependencies);
      if (snapshot.boardConfig) {
        queryClient.setQueryData<BoardColumnDef[]>(configKey(projectId), snapshot.boardConfig);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, queryClient]);

  // Persist the board's current state on every successful fetch so it is available
  // for the next offline open. Subscribe to the query cache and snapshot when the
  // task list for this project has data.
  useEffect(() => {
    if (!projectId) return;
    const cache = queryClient.getQueryCache();
    const persist = () => {
      const tasks = queryClient.getQueryData<Task[]>(tasksKey(projectId));
      if (!tasks || tasks.length === 0) return;
      void putBoardSnapshot({
        projectId,
        tasks,
        dependencies: queryClient.getQueryData<TaskLink[]>(depsKey(projectId)) ?? [],
        boardConfig: queryClient.getQueryData<BoardColumnDef[]>(configKey(projectId)) ?? null,
        savedAt: Date.now(),
      });
    };
    persist();
    const unsubscribe = cache.subscribe((event) => {
      const key = event.query.queryKey as readonly unknown[];
      if (key[0] === 'tasks' && key[1] === projectId) persist();
    });
    return unsubscribe;
  }, [projectId, queryClient]);

  // Flush queued moves on reconnect.
  useEffect(() => {
    if (!projectId) return;
    const onOnline = () => {
      void flushBoardOutbox(queryClient, projectId);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [projectId, queryClient]);
}
