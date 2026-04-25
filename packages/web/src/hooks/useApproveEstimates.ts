import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * POST /api/v1/tasks/{taskId}/approve-estimates/
 *
 * Accepts pending three-point estimates on a task (suggest_approve mode only).
 * Returns 400 if the project's estimation_mode is not suggest_approve.
 * Idempotent — already-accepted tasks return 200 without a DB write.
 *
 * On success, invalidates the task list for the given project so the
 * estimate_status badge updates immediately.
 */
export function useApproveEstimates(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskId: string) => {
      const res = await apiClient.post<{ estimate_status: string }>(
        `/tasks/${taskId}/approve-estimates/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}
