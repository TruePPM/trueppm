import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export function useRemoveMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (membershipId: string) => {
      await apiClient.delete(`/projects/${projectId}/members/${membershipId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members', projectId] });
    },
  });
}
