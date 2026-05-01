import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { TaskStatus } from '@/types';

/** PATCH /api/v1/tasks/{id}/ — update task status and optionally reparent (used by Kanban board drag-and-drop and keyboard move). */
export function useUpdateTaskStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      taskId,
      status,
      parentId,
    }: {
      projectId: string;
      taskId: string;
      status: TaskStatus;
      parentId?: string | null;
    }) => {
      const body: Record<string, unknown> = { status };
      if (parentId !== undefined) body['parent_id'] = parentId === 'root' ? null : parentId;
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
  });
}
