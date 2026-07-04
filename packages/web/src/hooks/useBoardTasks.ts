import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast/toast';
import type { TaskStatus } from '@/types';

/** PATCH /api/v1/tasks/{id}/ — update task status and optionally reparent (used by Kanban board drag-and-drop and keyboard move). */
export function useUpdateTaskStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      taskId,
      status,
      parentId,
      sprintId,
    }: {
      projectId: string;
      taskId: string;
      status: TaskStatus;
      parentId?: string | null;
      /** #429: set when a card is dragged into a phase under a sprint view, to
       *  assign it to that sprint. The backend flags sprint_pending for an
       *  ACTIVE sprint (ADR-0102). Omitted for Project view. */
      sprintId?: string | null;
    }) => {
      const body: Record<string, unknown> = { status };
      if (parentId !== undefined) body['parent_id'] = parentId === 'root' ? null : parentId;
      if (sprintId !== undefined) body['sprint_id'] = sprintId;
      const res = await apiClient.patch<{ id: string; status: TaskStatus }>(
        `/tasks/${taskId}/`,
        body,
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['tasks', variables.projectId],
      });
    },
    // The card position is driven by the ['tasks'] cache, which is only
    // invalidated on success — so a failed move reverts the card silently. Fire
    // an explicit error toast so the user knows the move did not stick (#1631).
    onError: () => {
      toast.error("Couldn't move the card — try again.");
    },
  });
}
