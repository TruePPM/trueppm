import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Task } from '@/types';

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
  status?: string;
  actual_start?: string | null;
  actual_finish?: string | null;
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
// useRescheduleTask — PATCH for drag/resize with optimistic cache update
//
// Unlike useUpdateTask (which invalidates immediately), this hook applies an
// optimistic patch to the React Query cache in onMutate so both the canvas
// and task list update instantly. It does NOT call invalidateQueries — instead
// useGanttTasks polls every 2 s, which picks up CPM-computed dates once Celery
// finishes without causing a stale-data snap-back.
// ---------------------------------------------------------------------------

export interface RescheduleTaskPayload {
  id: string;
  projectId: string;
  planned_start?: string | null;
  duration?: number;
  /** Partial Task values applied to the cache immediately (optimistic UI). */
  optimistic: Partial<Task>;
}

export function useRescheduleTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      projectId: _p,
      optimistic: _o,
      ...data
    }: RescheduleTaskPayload) => {
      await apiClient.patch(`/tasks/${id}/`, data);
    },
    onMutate: async ({ id, projectId, optimistic }) => {
      // Cancel any in-flight fetches so they don't overwrite our optimistic data
      await queryClient.cancelQueries({ queryKey: ['tasks', projectId] });
      const snapshot = queryClient.getQueryData<Task[]>(['tasks', projectId]);
      queryClient.setQueryData<Task[]>(['tasks', projectId], (old) =>
        old?.map((t) => (t.id === id ? { ...t, ...optimistic } : t)) ?? [],
      );
      return { snapshot };
    },
    onError: (_err, { projectId }, context) => {
      // Roll back on API error
      if (context?.snapshot) {
        queryClient.setQueryData(['tasks', projectId], context.snapshot);
      }
    },
    // No onSuccess invalidation — useGanttTasks refetchInterval picks up CPM results
  });
}

// ---------------------------------------------------------------------------
// useIndentTask — POST /api/v1/projects/{pk}/tasks/{id}/indent/
// ---------------------------------------------------------------------------

export interface IndentOutdentResponse {
  updated: Array<{ id: string; wbs_path: string }>;
  warning: 'has_assignments' | null;
}

export function useIndentTask(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskId: string) => {
      const res = await apiClient.post<IndentOutdentResponse>(
        `/projects/${projectId}/tasks/${taskId}/indent/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useOutdentTask — POST /api/v1/projects/{pk}/tasks/{id}/outdent/
// ---------------------------------------------------------------------------

export function useOutdentTask(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskId: string) => {
      const res = await apiClient.post<IndentOutdentResponse>(
        `/projects/${projectId}/tasks/${taskId}/outdent/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useReparentTask — POST /api/v1/projects/{pk}/tasks/{id}/reparent/
// ---------------------------------------------------------------------------

export interface ReparentTaskPayload {
  taskId: string;
  /** UUID of the target parent, or null to promote to root level. */
  newParentId: string | null;
}

export function useReparentTask(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ taskId, newParentId }: ReparentTaskPayload) => {
      const res = await apiClient.post<IndentOutdentResponse>(
        `/projects/${projectId}/tasks/${taskId}/reparent/`,
        { new_parent_id: newParentId },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useDeleteTask — DELETE /api/v1/tasks/{id}/
// ---------------------------------------------------------------------------

export function useDeleteTask(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskId: string) => {
      await apiClient.delete(`/tasks/${taskId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useBulkDeleteTasks — POST /api/v1/projects/{pk}/tasks/bulk/ (delete ops)
// ---------------------------------------------------------------------------

export function useBulkDeleteTasks(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskIds: string[]) => {
      await apiClient.post(`/projects/${projectId}/tasks/bulk/`, {
        operations: taskIds.map((id) => ({ op: 'delete', id })),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
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
