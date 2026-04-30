/**
 * Workshop session hooks — start, end, and query the active session.
 *
 * useWorkshopSession fetches GET /projects/{pk}/workshop/current/ and returns
 * the active session (or null when none is active). The 404 case is treated as
 * "no active session" rather than an error.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { WorkshopSession } from '@/types';

export function useWorkshopSession(projectId: string | null | undefined) {
  return useQuery<WorkshopSession | null>({
    queryKey: ['workshopSession', projectId],
    queryFn: async () => {
      if (!projectId) return null;
      try {
        const res = await apiClient.get<WorkshopSession>(
          `/projects/${projectId}/workshop/current/`,
        );
        return res.data;
      } catch (err: unknown) {
        // 404 = no active session — not an error state
        if (
          err &&
          typeof err === 'object' &&
          'response' in err &&
          (err as { response?: { status?: number } }).response?.status === 404
        ) {
          return null;
        }
        throw err;
      }
    },
    enabled: Boolean(projectId),
    staleTime: 10_000,
    retry: false,
  });
}

export function useStartWorkshop(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<WorkshopSession>(
        `/projects/${projectId}/workshop/start/`,
      );
      return res.data;
    },
    onSuccess: (session) => {
      queryClient.setQueryData(['workshopSession', projectId], session);
    },
  });
}

export function useEndWorkshop(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<WorkshopSession>(
        `/projects/${projectId}/workshop/end/`,
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.setQueryData(['workshopSession', projectId], null);
    },
  });
}
