/**
 * Optimistic "pull to project" mutation (ADR-0069, decision D6).
 *
 * On `pull()` the item flips to PULLED in the cache immediately; the simulated
 * API call then confirms (filling in the real task id) or fails (rolling the
 * cache back to the pre-pull snapshot). `undo()` reverts a still-fresh pull
 * within the 8-second window the toast offers.
 *
 * `pullFn` / `undoFn` are injectable so the rollback path is unit-testable
 * without a server, and so the real endpoints drop in here later with no
 * change to `ProgramBacklogPage`.
 */

import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BacklogItem, MemberProject } from '../types';
import { backlogKeys, patchBacklogCache, readBacklogCache } from './useBacklogItems';

export interface PullArgs {
  item: BacklogItem;
  project: MemberProject;
}

export interface PullResult {
  taskId: string;
}

export interface UsePullItemOptions {
  /** Simulated by default; tests inject a rejecting fn to exercise rollback. */
  pullFn?: (args: PullArgs) => Promise<PullResult>;
  /** Reverse the pull server-side (DELETE the created task). */
  undoFn?: (args: { item: BacklogItem }) => Promise<void>;
}

const PULL_LATENCY_MS = 600;

const defaultPullFn = ({ item }: PullArgs): Promise<PullResult> =>
  new Promise((resolve) =>
    setTimeout(() => resolve({ taskId: `t-${item.id.toLowerCase()}` }), PULL_LATENCY_MS),
  );

const defaultUndoFn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

interface PullContext {
  snapshot: BacklogItem[] | undefined;
}

export interface UsePullItemResult {
  pull: (
    args: PullArgs,
    callbacks?: { onError?: (error: unknown) => void; onSuccess?: () => void },
  ) => void;
  undo: (item: BacklogItem) => Promise<void>;
  isPulling: boolean;
}

export function usePullItem(
  programId: string | undefined,
  options: UsePullItemOptions = {},
): UsePullItemResult {
  const queryClient = useQueryClient();
  const pullFn = options.pullFn ?? defaultPullFn;
  const undoFn = options.undoFn ?? defaultUndoFn;

  const mutation = useMutation<PullResult, unknown, PullArgs, PullContext>({
    mutationFn: pullFn,
    onMutate: async ({ item, project }) => {
      await queryClient.cancelQueries({ queryKey: backlogKeys.items(programId) });
      const snapshot = readBacklogCache(queryClient, programId);
      const at = new Date().toISOString();
      patchBacklogCache(queryClient, programId, (items) =>
        items.map((i) =>
          i.id === item.id
            ? {
                ...i,
                status: 'PULLED',
                updatedAt: at,
                pulledTo: {
                  projectId: project.id,
                  projectName: project.name,
                  taskId: 'pending',
                  at,
                },
              }
            : i,
        ),
      );
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      // Roll the whole list back to the pre-pull snapshot.
      if (context?.snapshot) {
        queryClient.setQueryData(backlogKeys.items(programId), context.snapshot);
      }
    },
    onSuccess: (result, { item }) => {
      // Replace the placeholder task id with the one the API minted.
      patchBacklogCache(queryClient, programId, (items) =>
        items.map((i) =>
          i.id === item.id && i.pulledTo
            ? { ...i, pulledTo: { ...i.pulledTo, taskId: result.taskId } }
            : i,
        ),
      );
    },
  });

  const pull: UsePullItemResult['pull'] = useCallback(
    (args, callbacks) => {
      mutation.mutate(args, {
        onError: (error) => callbacks?.onError?.(error),
        onSuccess: () => callbacks?.onSuccess?.(),
      });
    },
    [mutation],
  );

  const undo = useCallback(
    async (item: BacklogItem) => {
      patchBacklogCache(queryClient, programId, (items) =>
        items.map((i) =>
          i.id === item.id ? { ...i, status: 'PROPOSED', pulledTo: undefined } : i,
        ),
      );
      await undoFn({ item });
    },
    [queryClient, programId, undoFn],
  );

  return { pull, undo, isPulling: mutation.isPending };
}
