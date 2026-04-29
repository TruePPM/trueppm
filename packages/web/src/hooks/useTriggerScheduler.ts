import { useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Returns a function that POSTs to /projects/{id}/schedule/ to trigger a CPM
 * recalculation, then invalidates allocation and heatmap queries so the UI
 * refreshes automatically. (#242)
 */
export function useTriggerScheduler(projectId: string | undefined): () => Promise<void> {
  const queryClient = useQueryClient();

  return async () => {
    if (!projectId) return;
    await apiClient.post(`/projects/${projectId}/schedule/`);
    void queryClient.invalidateQueries({ queryKey: ['resource-allocation', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['resources-heatmap', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['resources-summary', projectId] });
  };
}
