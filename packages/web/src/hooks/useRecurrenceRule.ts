/**
 * Hooks for a task's recurrence rule (ADR-0090, #738).
 *
 * Backed by the top-level collection /api/v1/recurrence-rules/ filtered by
 * ?task={id} (one rule per task, so the paginated list carries 0 or 1 row, which
 * `useRecurrenceRule` unwraps to a single rule | null). Writes require Scheduler+
 * (the server 403s a Member); attaching a rule pulls the template out of the CPM
 * graph and detaching puts it back, so the backend re-triggers a schedule recompute
 * on commit — the client only invalidates the rule cache and lets sync/broadcast
 * refresh the board and schedule views.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { RecurrenceRuleInput, TaskRecurrenceRule } from '@/lib/recurrence';

export type { RecurrenceRuleInput, TaskRecurrenceRule } from '@/lib/recurrence';

const recurrenceKey = (taskId: string | null) => ['task-recurrence-rule', taskId];

const COLLECTION = '/recurrence-rules/';

/** GET /recurrence-rules/?task={taskId} → the task's rule, or null if none. */
export function useRecurrenceRule(projectId: string, taskId: string | null) {
  const query = useQuery({
    queryKey: recurrenceKey(taskId),
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<TaskRecurrenceRule>>(COLLECTION, {
        params: { task: taskId, project: projectId },
      });
      return res.data.results[0] ?? null;
    },
    enabled: !!taskId && !!projectId,
  });

  return {
    rule: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** POST /recurrence-rules/ — attach a rule (Scheduler+); triggers a CPM recompute server-side. */
export function useCreateRecurrenceRule() {
  const queryClient = useQueryClient();
  return useMutation<TaskRecurrenceRule, Error, RecurrenceRuleInput>({
    mutationFn: async (input) => {
      const res = await apiClient.post<TaskRecurrenceRule>(COLLECTION, input);
      return res.data;
    },
    onSuccess: (rule) => {
      void queryClient.invalidateQueries({ queryKey: recurrenceKey(rule.task) });
    },
  });
}

interface UpdateVars {
  ruleId: string;
  taskId: string;
  patch: Partial<RecurrenceRuleInput>;
}

/** PATCH /recurrence-rules/{id}/ — edit an existing rule (Scheduler+). */
export function useUpdateRecurrenceRule() {
  const queryClient = useQueryClient();
  return useMutation<TaskRecurrenceRule, Error, UpdateVars>({
    mutationFn: async ({ ruleId, patch }) => {
      const res = await apiClient.patch<TaskRecurrenceRule>(`${COLLECTION}${ruleId}/`, patch);
      return res.data;
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: recurrenceKey(taskId) });
    },
  });
}

interface DeleteVars {
  ruleId: string;
  taskId: string;
}

/** DELETE /recurrence-rules/{id}/ — stop recurring (Scheduler+); template rejoins CPM. */
export function useDeleteRecurrenceRule() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteVars>({
    mutationFn: async ({ ruleId }) => {
      await apiClient.delete(`${COLLECTION}${ruleId}/`);
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: recurrenceKey(taskId) });
    },
  });
}
