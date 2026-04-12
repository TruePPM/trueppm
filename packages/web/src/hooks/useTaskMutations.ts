import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

// ---------------------------------------------------------------------------
// Shared API shape — returned by POST /tasks/ and PATCH /tasks/{id}/
// ---------------------------------------------------------------------------

interface ApiTaskResponse {
  id: string;
  name: string;
  project: string;
  wbs_path: string | null;
  duration: number;
  status: string;
  percent_complete: number;
}

// ---------------------------------------------------------------------------
// useCreateTask — POST /api/v1/tasks/
// ---------------------------------------------------------------------------

export interface CreateTaskPayload {
  name: string;
  duration: number;
}

export function useCreateTask(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: CreateTaskPayload) => {
      const res = await apiClient.post<ApiTaskResponse>('/tasks/', {
        project: projectId,
        name: payload.name,
        duration: payload.duration,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpdateTask — PATCH /api/v1/tasks/{id}/
// ---------------------------------------------------------------------------

export interface UpdateTaskPayload {
  id: string;
  projectId: string;
  name?: string;
  duration?: number;
  percent_complete?: number;
  planned_start?: string | null;
}

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, projectId: _projectId, ...data }: UpdateTaskPayload) => {
      const res = await apiClient.patch<ApiTaskResponse>(`/tasks/${id}/`, data);
      return res.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', variables.projectId] });
    },
  });
}

// ---------------------------------------------------------------------------
// useReorderTasks — POST /api/v1/projects/{pk}/tasks/reorder/
// ---------------------------------------------------------------------------

export interface ReorderTasksPayload {
  /** ltree path of the common parent, or "" for root level. */
  parent_path: string;
  /** All live siblings in desired order — partial lists are rejected by the API. */
  ordered_ids: string[];
}

export function useReorderTasks(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: ReorderTasksPayload) => {
      await apiClient.post(`/projects/${projectId}/tasks/reorder/`, payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}
