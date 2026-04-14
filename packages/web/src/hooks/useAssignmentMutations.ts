import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { TaskAssignment } from '@/types';

interface ApiTaskResource {
  id: string;
  resource: string;
  resource_name: string;
  units: number;
}

function mapAssignment(a: ApiTaskResource): TaskAssignment {
  return {
    id: a.id,
    resourceId: a.resource,
    resourceName: a.resource_name,
    units: a.units,
  };
}

// ---------------------------------------------------------------------------
// useAddAssignment — POST /api/v1/task-resources/
// ---------------------------------------------------------------------------

export interface AddAssignmentPayload {
  taskId: string;
  resourceId: string;
  units: number;
}

export function useAddAssignment(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ taskId, resourceId, units }: AddAssignmentPayload) => {
      const res = await apiClient.post<ApiTaskResource>('/task-resources/', {
        task: taskId,
        resource: resourceId,
        units,
      });
      return mapAssignment(res.data);
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: ['task-assignments', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['gantt-tasks', projectId] });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpdateAssignment — PATCH /api/v1/task-resources/{id}/
// ---------------------------------------------------------------------------

export interface UpdateAssignmentPayload {
  id: string;
  units: number;
}

export function useUpdateAssignment(taskId: string, projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, units }: UpdateAssignmentPayload) => {
      const res = await apiClient.patch<ApiTaskResource>(`/task-resources/${id}/`, { units });
      return mapAssignment(res.data);
    },
    onMutate: async ({ id, units }) => {
      await queryClient.cancelQueries({ queryKey: ['task-assignments', taskId] });
      const snapshot = queryClient.getQueryData<TaskAssignment[]>(['task-assignments', taskId]);
      queryClient.setQueryData<TaskAssignment[]>(
        ['task-assignments', taskId],
        (prev) => prev?.map((a) => (a.id === id ? { ...a, units } : a)),
      );
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot !== undefined) {
        queryClient.setQueryData(['task-assignments', taskId], context.snapshot);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-assignments', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['gantt-tasks', projectId] });
    },
  });
}

// ---------------------------------------------------------------------------
// useRemoveAssignment — DELETE /api/v1/task-resources/{id}/
// ---------------------------------------------------------------------------

export function useRemoveAssignment(taskId: string, projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (assignmentId: string) => {
      await apiClient.delete(`/task-resources/${assignmentId}/`);
    },
    onMutate: async (assignmentId) => {
      await queryClient.cancelQueries({ queryKey: ['task-assignments', taskId] });
      const snapshot = queryClient.getQueryData<TaskAssignment[]>(['task-assignments', taskId]);
      queryClient.setQueryData<TaskAssignment[]>(
        ['task-assignments', taskId],
        (prev) => prev?.filter((a) => a.id !== assignmentId),
      );
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot !== undefined) {
        queryClient.setQueryData(['task-assignments', taskId], context.snapshot);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-assignments', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['gantt-tasks', projectId] });
    },
  });
}
