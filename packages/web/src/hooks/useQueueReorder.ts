/**
 * Queue reorder hook — POST /projects/{pk}/queue/reorder/
 *
 * Promote / demote a task within the board queue's priority-sorted groups
 * (Next up · In flight). Accepts one group's entries (id + serverVersion) in the
 * new display order and sends the issue-1610 body shape; the server writes dense
 * priority_rank = position * 10. A 409 (a row moved under the client) surfaces as
 * QueueVersionConflictError so the caller can refetch and snap to server order.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { apiClient } from '@/api/client';

export interface QueueReorderEntry {
  id: string;
  serverVersion: number;
}

export class QueueVersionConflictError extends Error {
  constructor() {
    super('Queue changed — another participant updated the order. Refreshing.');
    this.name = 'QueueVersionConflictError';
  }
}

export function useQueueReorder(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (tasks: QueueReorderEntry[]) => {
      try {
        await apiClient.post(`/projects/${projectId}/queue/reorder/`, {
          tasks: tasks.map((t) => ({ id: t.id, server_version: t.serverVersion })),
        });
      } catch (err) {
        const axiosErr = err as AxiosError;
        if (axiosErr?.response?.status === 409) {
          throw new QueueVersionConflictError();
        }
        throw err;
      }
    },
    // The board tasks query owns the queue's ordering; invalidate so the reordered
    // ranks (and any concurrent server changes) are the source of truth.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
    onError: (err) => {
      // On version conflict invalidate immediately so the UI snaps to server order.
      // A non-conflict failure is rethrown verbatim with no invalidate.
      if (err instanceof QueueVersionConflictError) {
        void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
      }
    },
  });
}
