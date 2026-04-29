import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Risk, RiskComment, PaginatedResponse } from '@/api/types';

export interface CreateRiskPayload {
  title: string;
  description: string;
  status: Risk['status'];
  probability: number;
  impact: number;
  owner: string | null;
  tasks: string[];
  // PMI framework fields (ADR-0043) — all optional
  category?: Risk['category'];
  response?: Risk['response'];
  mitigation_due_date?: string | null;
  trigger?: string;
  contingency?: string;
}

export interface UseRisksResult {
  risks: Risk[];
  isLoading: boolean;
  error: Error | null;
}

/** GET /api/v1/projects/{id}/risks/ — fetch all risks for a project. */
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

/** POST /api/v1/projects/{id}/risks/ — create a new risk with optional linked tasks. */
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

/** PATCH /api/v1/projects/{id}/risks/{id}/ — update risk fields or linked tasks. */
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

/** DELETE /api/v1/projects/{id}/risks/{id}/ — delete a risk. */
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

/** GET /api/v1/projects/{id}/risks/{riskId}/comments/ — fetch all comments for a risk. */
export function useRiskComments(projectId: string, riskId: string | null) {
  const query = useQuery({
    queryKey: ['risk-comments', riskId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<RiskComment>>(
        `/projects/${projectId}/risks/${riskId}/comments/`,
      );
      return res.data.results;
    },
    enabled: !!riskId,
  });

  return {
    comments: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** POST /api/v1/projects/{id}/risks/{riskId}/comments/ — add a comment to a risk. */
export function useCreateRiskComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      riskId,
      message,
    }: {
      projectId: string;
      riskId: string;
      message: string;
    }) => {
      const res = await apiClient.post<RiskComment>(
        `/projects/${projectId}/risks/${riskId}/comments/`,
        { message },
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['risk-comments', variables.riskId],
      });
    },
  });
}
