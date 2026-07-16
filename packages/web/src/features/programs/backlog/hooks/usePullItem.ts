/**
 * Optimistic "pull to project" mutation (ADR-0069 pull action, #737).
 *
 * On `pull()` the item flips to PULLED in the cache immediately; the API call
 * then confirms (filling in the real task id) or fails (rolling the cache back
 * to the pre-pull snapshot, surfacing a retryable error). There is no un-pull
 * endpoint, so a committed pull is not reversible from here — the toast is a
 * confirmation, not an undo.
 *
 * `pullFn` is injectable so the optimistic + rollback paths are unit-testable
 * without a server.
 */

import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
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
  /** Tests inject a resolving/rejecting fn to exercise success + rollback. */
  pullFn?: (args: PullArgs, programId: string | undefined) => Promise<PullResult>;
}

const defaultPullFn = async (
  { item, project }: PullArgs,
  programId: string | undefined,
): Promise<PullResult> => {
  const res = await apiClient.post<{ task: { id: string } }>(
    `/programs/${programId}/backlog-items/${item.id}/pull/`,
    { project_id: project.id },
  );
  return { taskId: res.data.task.id };
};

interface PullContext {
  snapshot: BacklogItem[] | undefined;
}

export interface UsePullItemResult {
  pull: (
    args: PullArgs,
    callbacks?: { onError?: (error: unknown) => void; onSuccess?: (result: PullResult) => void },
  ) => void;
  isPulling: boolean;
}

export function usePullItem(
  programId: string | undefined,
  options: UsePullItemOptions = {},
): UsePullItemResult {
  const queryClient = useQueryClient();
  const pullFn = options.pullFn ?? defaultPullFn;

  const mutation = useMutation<PullResult, unknown, PullArgs, PullContext>({
    mutationFn: (args) => pullFn(args, programId),
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
                  taskId: 'pending',
                  at,
                  projectId: project.id,
                  projectName: project.name,
                },
              }
            : i,
        ),
      );
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(backlogKeys.items(programId), context.snapshot);
      }
    },
    onSuccess: (result, { item }) => {
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
        onSuccess: (result) => callbacks?.onSuccess?.(result),
      });
    },
    [mutation],
  );

  return { pull, isPulling: mutation.isPending };
}
