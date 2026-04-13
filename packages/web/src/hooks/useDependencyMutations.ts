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
      void queryClient.invalidateQueries({
        queryKey: ['dependencies', projectId ?? undefined],
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

export function useUpdateDependency(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: UpdateDependencyPayload) => {
      const res = await apiClient.patch<ApiDependency>(`/dependencies/${id}/`, data);
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['dependencies', projectId ?? undefined],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// useDeleteDependency — DELETE /api/v1/dependencies/{id}/
// ---------------------------------------------------------------------------

export function useDeleteDependency(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (depId: string) => {
      await apiClient.delete(`/dependencies/${depId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['dependencies', projectId ?? undefined],
      });
    },
  });
}
