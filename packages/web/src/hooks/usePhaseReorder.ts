/**
 * Phase reorder hook — PATCH /projects/{pk}/phases/reorder/
 *
 * Used exclusively in workshop mode when the user drags phase columns into a new
 * order. Sets priority_rank on WBS L1 summary tasks and triggers a board refresh.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export function usePhaseReorder(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (orderedIds: string[]) => {
      await apiClient.patch(`/projects/${projectId}/phases/reorder/`, {
        ordered_ids: orderedIds,
      });
    },
    onSuccess: () => {
      // Invalidate so the next tasks fetch reflects the new priority_rank order.
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}
