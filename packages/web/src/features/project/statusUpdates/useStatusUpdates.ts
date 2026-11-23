import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { StatusUpdate } from '@/api/types';
import type { Rag } from '@/lib/ragBand';

interface StatusUpdatePage {
  count: number;
  next: string | null;
  previous: string | null;
  results: StatusUpdate[];
}

/** TanStack key for a project's status-update history (newest first, first page). */
export const statusUpdatesKey = (projectId: string) => ['status-updates', projectId] as const;

/**
 * A project's posted status updates, newest first, each with its frozen snapshot
 * and the API's live diff (#4803). The first page (20) is the history the Overview
 * shows; older updates are not paged in yet.
 */
export function useStatusUpdates(projectId: string) {
  return useQuery<StatusUpdatePage>({
    queryKey: statusUpdatesKey(projectId),
    queryFn: async () =>
      (await apiClient.get<StatusUpdatePage>(`/projects/${projectId}/status-updates/`)).data,
  });
}

/**
 * Posts the PM's call. Not optimistic: the snapshot is frozen by the server at
 * post time, so there is nothing truthful to show before the response. On success
 * the history is refetched so the new row carries the server's snapshot.
 */
export function usePostStatusUpdate(projectId: string) {
  const qc = useQueryClient();
  return useMutation<
    StatusUpdate,
    unknown,
    { rag: Rag; narrative: string; idempotencyKey: string }
  >({
    // The key makes a retry of a post that committed but lost its response replay the
    // stored result instead of minting a second, uneditable update.
    mutationFn: async ({ idempotencyKey, ...body }) =>
      (
        await apiClient.post<StatusUpdate>(`/projects/${projectId}/status-updates/`, body, {
          headers: { 'Idempotency-Key': idempotencyKey },
        })
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: statusUpdatesKey(projectId) }),
  });
}
