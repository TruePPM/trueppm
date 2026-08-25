import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast/toast';
import type { TaskAssignment } from '@/types';

interface ApiTaskResource {
  id: string;
  resource: string;
  resource_name: string;
  units: number;
}

/**
 * A warning returned by the POST /task-resources/ 201 response (ADR-0028, issue #150).
 *
 * `assignment_not_unit_tracked` (#3047) accompanies `resource_overallocated` when the
 * total folds in a bare-`Task.assignee` task with no `TaskResource` row — the response
 * carries it so a caller knows the total includes a full-unit estimate rather than a
 * real `TaskResource.units` figure. No UI currently reads this code specifically; it
 * falls through unrendered like any other unrecognized warning, same as before #3047.
 */
export interface AssignmentWarning {
  code: 'resource_overallocated' | 'skill_mismatch' | 'assignment_not_unit_tracked';
  resource_id: string;
  resource_name: string;
  detail: string;
  /** Comma-separated task ids, present only on `assignment_not_unit_tracked`. */
  task_ids?: string;
}

/** Shape returned by the POST /task-resources/ endpoint including optional warnings. */
interface ApiTaskResourceWithWarnings extends ApiTaskResource {
  warnings: AssignmentWarning[];
}

function mapAssignment(a: ApiTaskResource): TaskAssignment {
  return {
    id: a.id,
    resourceId: a.resource,
    resourceName: a.resource_name,
    units: a.units,
  };
}

/** Result returned by the useAddAssignment mutationFn — includes the new assignment and any warnings. */
export interface AddAssignmentResult {
  assignment: TaskAssignment;
  warnings: AssignmentWarning[];
}

// ---------------------------------------------------------------------------
// useAddAssignment — POST /api/v1/task-resources/
// ---------------------------------------------------------------------------

export interface AddAssignmentPayload {
  taskId: string;
  resourceId: string;
  units: number;
}

/** POST /api/v1/task-resources/ — assign a resource to a task at a given allocation percentage. */
export function useAddAssignment(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<AddAssignmentResult, Error, AddAssignmentPayload>({
    mutationFn: async ({ taskId, resourceId, units }: AddAssignmentPayload) => {
      const res = await apiClient.post<ApiTaskResourceWithWarnings>('/task-resources/', {
        task: taskId,
        resource: resourceId,
        units,
      });
      return {
        assignment: mapAssignment(res.data),
        warnings: res.data.warnings ?? [],
      };
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: ['task-assignments', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
    // The combobox closes in the caller's onSettled regardless of outcome, so a
    // failed add would otherwise vanish with no signal. Fire an explicit error
    // toast so the user knows the resource was not assigned (issue 1631).
    onError: () => {
      toast.error("Couldn't add the resource — try again.");
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

/**
 * PATCH /api/v1/task-resources/{id}/ — update a resource allocation percentage.
 * Applies an optimistic update and rolls back on error.
 */
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
      toast.error("Couldn't update the allocation — try again.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-assignments', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

// ---------------------------------------------------------------------------
// useRemoveAssignment — DELETE /api/v1/task-resources/{id}/
// ---------------------------------------------------------------------------

/**
 * DELETE /api/v1/task-resources/{id}/ — remove a resource from a task.
 * Applies an optimistic removal and rolls back on error.
 */
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
      toast.error("Couldn't remove the resource — try again.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-assignments', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}
