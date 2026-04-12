import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api';
import type { PaginatedResponse } from '@/api/types';

// ---------------------------------------------------------------------------
// API shapes (matches BaselineSerializer / BaselineDetailSerializer)
// ---------------------------------------------------------------------------

export interface ApiBaseline {
  id: string;
  project: string;
  name: string;
  created_by: string | null;
  created_at: string;
  is_active: boolean;
  has_cpm_dates: boolean;
  task_count: number;
}

export interface ApiBaselineTask {
  task_id: string;
  task_name: string;
  start: string;
  finish: string;
  duration: number;
}

export interface ApiBaselineDetail extends ApiBaseline {
  tasks: ApiBaselineTask[];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** List all baselines for a project. */
export function useBaselines(projectId: string | null | undefined) {
  return useQuery<ApiBaseline[], Error>({
    queryKey: ['baselines', projectId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiBaseline>>(
        `/projects/${projectId}/baselines/`,
      );
      return res.data.results;
    },
    enabled: !!projectId,
  });
}

/** Retrieve a single baseline with its full task snapshot. */
export function useBaselineDetail(
  projectId: string | null | undefined,
  baselineId: string | null | undefined,
) {
  return useQuery<ApiBaselineDetail, Error>({
    queryKey: ['baselines', projectId, baselineId],
    queryFn: async () => {
      const res = await apiClient.get<ApiBaselineDetail>(
        `/projects/${projectId}/baselines/${baselineId}/`,
      );
      return res.data;
    },
    enabled: !!projectId && !!baselineId,
  });
}

/** Create a new baseline snapshot (POST — optionally pass { name }). */
export function useCreateBaseline(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ApiBaseline, Error, { name?: string } | void>({
    mutationFn: async (body) => {
      const res = await apiClient.post<ApiBaseline>(
        `/projects/${projectId}/baselines/`,
        body ?? {},
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['baselines', projectId] });
    },
  });
}

/** Activate an existing baseline. */
export function useActivateBaseline(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ApiBaseline, Error, string>({
    mutationFn: async (baselineId) => {
      const res = await apiClient.post<ApiBaseline>(
        `/projects/${projectId}/baselines/${baselineId}/activate/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['baselines', projectId] });
      // Active baseline changes which overlay is applied to tasks.
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

/** Soft-delete a baseline. */
export function useDeleteBaseline(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (baselineId) => {
      await apiClient.delete(`/projects/${projectId}/baselines/${baselineId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['baselines', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}
