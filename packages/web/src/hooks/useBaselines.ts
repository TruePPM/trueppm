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

/**
 * Create a new baseline snapshot (POST — optionally pass { name }).
 *
 * Auto-activates the FIRST baseline (#2215). Server-side board-card readiness
 * (`TaskSerializer.get_readiness`) only resolves to `baselined` under the
 * project's ACTIVE baseline, but capture saves `is_active=false`, so a first
 * capture would otherwise leave every card at `estimated` until a separate
 * "Set active" step — contradicting the confirm dialog's promise that the
 * snapshot becomes the active baseline. When the project has no active baseline
 * yet, this chains the activate call and refreshes `['tasks']` so the cards flip
 * with no extra step. Capturing an ADDITIONAL baseline while one is already
 * active must NOT silently reactivate — "Set active" stays the explicit path —
 * so the activate is skipped in that case.
 */
export function useCreateBaseline(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ApiBaseline, Error, { name?: string } | void>({
    mutationFn: async (body) => {
      const res = await apiClient.post<ApiBaseline>(
        `/projects/${projectId}/baselines/`,
        body ?? {},
      );
      const created = res.data;
      // Decide auto-activation from the authoritative list rather than the
      // possibly-cold ['baselines'] cache (the quick-capture path in
      // ScheduleView never mounts the manager that populates it). The
      // just-created row is always inactive, so exclude it before checking.
      const list = await apiClient.get<PaginatedResponse<ApiBaseline>>(
        `/projects/${projectId}/baselines/`,
      );
      const hasActiveBaseline = list.data.results.some(
        (b) => b.is_active && b.id !== created.id,
      );
      if (hasActiveBaseline) return created;
      const activated = await apiClient.post<ApiBaseline>(
        `/projects/${projectId}/baselines/${created.id}/activate/`,
      );
      return activated.data;
    },
    onSuccess: (baseline) => {
      void queryClient.invalidateQueries({ queryKey: ['baselines', projectId] });
      // An auto-activated first baseline becomes the overlay applied to tasks,
      // so readiness/board cards must refresh. A non-activating capture (an
      // additional baseline) leaves task readiness unchanged.
      if (baseline.is_active) {
        void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
      }
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
