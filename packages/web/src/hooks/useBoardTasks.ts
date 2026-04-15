import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { TaskStatus } from '@/types';

/** PATCH /api/v1/tasks/{id}/ — update task status only (used by Kanban board drag-and-drop and keyboard move). */
export function useUpdateTaskStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      taskId,
      status,
    }: {
      projectId: string;
      taskId: string;
      status: TaskStatus;
    }) => {
      const res = await apiClient.patch<{ id: string; status: TaskStatus }>(
        `/tasks/${taskId}/`,
        { status },
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
