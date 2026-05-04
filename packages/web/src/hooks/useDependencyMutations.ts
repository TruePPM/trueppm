import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { LinkType } from '@/types';

interface ApiDependency {
  id: string;
  predecessor: string;
  successor: string;
  dep_type: LinkType;
  lag: number;
  is_critical: boolean;
}

// ---------------------------------------------------------------------------
// useCreateDependency — POST /api/v1/dependencies/
// ---------------------------------------------------------------------------

export interface CreateDependencyPayload {
  predecessor: string;
  successor: string;
  dep_type: LinkType;
  lag?: number;
}

/** POST /api/v1/dependencies/ — create a FS/SS/FF/SF dependency link between two tasks. */
export function useCreateDependency(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: CreateDependencyPayload) => {
      const res = await apiClient.post<ApiDependency>('/dependencies/', {
        ...payload,
        lag: payload.lag ?? 0,
      });
      return res.data;
    },
    onSuccess: () => {
      // Invalidate both keys: the dependency edge changed, and the CPM cascade
      // will shift early/late dates on the successor and its downstream tasks.
      // Relying solely on the cpm_complete WS event leaves the originating
      // client stale when the tab is backgrounded or the socket drops (#314).
      void queryClient.invalidateQueries({
        queryKey: ['dependencies', projectId ?? undefined],
      });
      void queryClient.invalidateQueries({
        queryKey: ['tasks', projectId ?? undefined],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpdateDependency — PATCH /api/v1/dependencies/{id}/
// ---------------------------------------------------------------------------

export interface UpdateDependencyPayload {
  id: string;
  dep_type?: LinkType;
  lag?: number;
}

/** PATCH /api/v1/dependencies/{id}/ — update dep_type or lag on an existing dependency. */
export function useUpdateDependency(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: UpdateDependencyPayload) => {
      const res = await apiClient.patch<ApiDependency>(`/dependencies/${id}/`, data);
      return res.data;
    },
    onSuccess: () => {
      // See useCreateDependency: dep edits cascade through CPM, so the tasks
      // query must be invalidated alongside dependencies (#314).
      void queryClient.invalidateQueries({
        queryKey: ['dependencies', projectId ?? undefined],
      });
      void queryClient.invalidateQueries({
        queryKey: ['tasks', projectId ?? undefined],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// useDeleteDependency — DELETE /api/v1/dependencies/{id}/
// ---------------------------------------------------------------------------

/** DELETE /api/v1/dependencies/{id}/ — remove a task dependency link. */
export function useDeleteDependency(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (depId: string) => {
      await apiClient.delete(`/dependencies/${depId}/`);
    },
    onSuccess: () => {
      // See useCreateDependency: dep deletion cascades through CPM, so the
      // tasks query must be invalidated alongside dependencies (#314).
      void queryClient.invalidateQueries({
        queryKey: ['dependencies', projectId ?? undefined],
      });
      void queryClient.invalidateQueries({
        queryKey: ['tasks', projectId ?? undefined],
      });
    },
  });
}
