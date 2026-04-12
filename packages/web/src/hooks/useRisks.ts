import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Risk, PaginatedResponse } from '@/api/types';

export interface CreateRiskPayload {
  title: string;
  description: string;
  status: Risk['status'];
  probability: number;
  impact: number;
  owner: string | null;
  tasks: string[];
}

export interface UseRisksResult {
  risks: Risk[];
  isLoading: boolean;
  error: Error | null;
}

export function useRisks(projectId: string | null): UseRisksResult {
  const query = useQuery({
    queryKey: ['risks', projectId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<Risk>>(`/projects/${projectId}/risks/`);
      return res.data.results;
    },
    enabled: !!projectId,
  });

  return {
    risks: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useCreateRisk() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      data,
    }: {
      projectId: string;
      data: CreateRiskPayload;
    }) => {
      const res = await apiClient.post<Risk>(
        `/projects/${projectId}/risks/`,
        data,
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['risks', variables.projectId],
      });
    },
  });
}

export function useUpdateRisk() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      id,
      data,
    }: {
      projectId: string;
      id: string;
      data: Partial<CreateRiskPayload>;
    }) => {
      const res = await apiClient.patch<Risk>(
        `/projects/${projectId}/risks/${id}/`,
        data,
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['risks', variables.projectId],
      });
    },
  });
}

export function useDeleteRisk() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      id,
    }: {
      projectId: string;
      id: string;
    }) => {
      await apiClient.delete(`/projects/${projectId}/risks/${id}/`);
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['risks', variables.projectId],
      });
    },
  });
}
