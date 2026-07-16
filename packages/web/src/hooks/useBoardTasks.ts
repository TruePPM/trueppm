import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast/toast';
import type { TaskStatus } from '@/types';
import { queueOfflineCardStatus } from '@/features/board/offline/useBoardOffline';
import {
  optimisticStatusPatch,
  type CardStatusVars,
} from '@/features/board/offline/cardStatusQueue';
import type { Task } from '@/types';

/** The move a caller requests — `useUpdateTaskStatus().mutate(vars)`. */
type UpdateTaskStatusVars = CardStatusVars;

export interface UpdateTaskStatusHandle {
  /** Move a card. When offline the write is queued to IndexedDB (ADR-0220); when
   *  online it PATCHes immediately, preserving the ADR-0205 SyncStatusBadge signal. */
  mutate: (vars: UpdateTaskStatusVars) => void;
  /** True while the online PATCH is in flight (unchanged online-path semantics). */
  isPending: boolean;
}

/**
 * PATCH /api/v1/tasks/{id}/ — update task status and optionally reparent (used by
 * Kanban board drag-and-drop and keyboard move).
 *
 * Connectivity-aware (ADR-0220) without changing its call sites: online it runs
 * the network mutation unchanged (so board moves stay server-authoritative and
 * remain visible to the shell SyncStatusBadge); offline it applies an optimistic
 * update and queues the move to a durable IndexedDB outbox that flushes on
 * reconnect. Only card-status moves diverge from ADR-0205's in-memory pause.
 */
export function useUpdateTaskStatus(): UpdateTaskStatusHandle {
  const queryClient = useQueryClient();

  const netMutation = useMutation({
    mutationFn: async ({ taskId, status, parentId, sprintId }: UpdateTaskStatusVars) => {
      const body: Record<string, unknown> = { status };
      if (parentId !== undefined) body['parent_id'] = parentId === 'root' ? null : parentId;
      // #429: sprintId is set when a card is dragged into a phase under a sprint
      // view, to assign it to that sprint. The backend flags sprint_pending for an
      // ACTIVE sprint (ADR-0102). Omitted for Project view.
      if (sprintId !== undefined) body['sprint_id'] = sprintId;
      const res = await apiClient.patch<{ id: string; status: TaskStatus }>(
        `/tasks/${taskId}/`,
        body,
      );
      return res.data;
    },
    // Optimistically move the card in the ['tasks'] cache so the drop lands
    // instantly online, matching the offline queue's snappy behavior (#2037).
    // Without this the card sat in the source column for the full PATCH +
    // invalidate + refetch round-trip — a visible snap-back-then-jump on every
    // drag. Mirrors useUpdateTask's optimistic pattern (#965) and reuses the
    // exact patch shape the offline path applies (optimisticStatusPatch).
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['tasks', vars.projectId] });
      const snapshot = queryClient.getQueryData<Task[]>(['tasks', vars.projectId]);
      const patch = optimisticStatusPatch(vars);
      queryClient.setQueryData<Task[]>(
        ['tasks', vars.projectId],
        (old) => old?.map((t) => (t.id === vars.taskId ? { ...t, ...patch } : t)) ?? [],
      );
      return { snapshot };
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['tasks', variables.projectId],
      });
    },
    // Roll the optimistic patch back to the pre-move snapshot, then surface an
    // explicit toast so the user knows the move did not stick (issue 1631).
    onError: (_err, variables, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(['tasks', variables.projectId], context.snapshot);
      }
      toast.error("Couldn't move the card — try again.");
    },
  });

  const mutate = useCallback(
    (vars: UpdateTaskStatusVars) => {
      // Read connectivity at call time (not render time) so a card dragged the
      // instant after going offline still queues rather than racing a dead request.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        queueOfflineCardStatus(queryClient, vars);
        return;
      }
      netMutation.mutate(vars);
    },
    [queryClient, netMutation],
  );

  return { mutate, isPending: netMutation.isPending };
}
