import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { RelationCard, RelationType, TaskRelation } from '@/types';

// ---------------------------------------------------------------------------
// Wire shapes — snake_case, mapped to the camelCase domain types on read.
// ---------------------------------------------------------------------------

interface ApiRelationCard {
  id: string;
  title: string;
  hex_id: string;
  project_id: string;
  project_name: string;
  is_milestone: boolean;
  early_start: string | null;
  early_finish: string | null;
  is_critical: boolean;
}

interface ApiTaskRelation {
  id: string;
  source: string;
  target: string;
  relation_type: RelationType;
  note: string | null;
  created_by: string | null;
  created_at: string;
  source_card: ApiRelationCard | null;
  target_card: ApiRelationCard | null;
}

function mapCard(c: ApiRelationCard | null | undefined): RelationCard | null {
  if (!c) return null;
  return {
    id: c.id,
    title: c.title,
    hexId: c.hex_id,
    projectId: c.project_id,
    projectName: c.project_name,
    isMilestone: c.is_milestone,
    earlyStart: c.early_start,
    earlyFinish: c.early_finish,
    isCritical: c.is_critical,
  };
}

function mapRelation(r: ApiTaskRelation): TaskRelation {
  return {
    id: r.id,
    source: r.source,
    target: r.target,
    relationType: r.relation_type,
    note: r.note ?? '',
    createdBy: r.created_by,
    createdAt: r.created_at,
    sourceCard: mapCard(r.source_card),
    targetCard: mapCard(r.target_card),
  };
}

export interface TaskRelationsResult {
  /** Relations where this task is the `source` — rendered with the forward label. */
  outgoing: TaskRelation[];
  /** Relations where this task is the `target` — rendered with the inverse label. */
  incoming: TaskRelation[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * GET /api/v1/task-relations/?task=<id> — fetch every relative link touching a
 * task and split it by direction (#2068). A relation is `outgoing` when the
 * task is the `source` (forward label) and `incoming` when it is the `target`
 * (inverse label). The endpoint returns a bare array, not a paginated envelope.
 *
 * Cache key is `['task-relations', taskId]`. Relations are a non-scheduling
 * cross-reference: they never shift a task's dates or the CPM float, so —
 * unlike the dependency mutations — the `['tasks', ...]` cache is deliberately
 * left untouched (see the mutation hooks below).
 */
export function useTaskRelations(taskId: string | null): TaskRelationsResult {
  const query = useQuery({
    queryKey: ['task-relations', taskId],
    queryFn: async () => {
      const res = await apiClient.get<ApiTaskRelation[]>('/task-relations/', {
        params: { task: taskId },
      });
      return res.data.map(mapRelation);
    },
    enabled: !!taskId,
  });

  const relations = query.data ?? [];

  return {
    outgoing: relations.filter((r) => r.source === taskId),
    incoming: relations.filter((r) => r.target === taskId),
    isLoading: query.isLoading,
    error: query.error,
  };
}

// ---------------------------------------------------------------------------
// Mutations — all invalidate ONLY ['task-relations', taskId]. A relation has no
// scheduling effect, so we never invalidate ['tasks', ...] (the opposite of the
// dependency mutations, which cascade through CPM).
// ---------------------------------------------------------------------------

export interface CreateTaskRelationPayload {
  source: string;
  target: string;
  relation_type: RelationType;
  note?: string;
}

/** POST /api/v1/task-relations/ — create a relative link between two tasks. */
export function useCreateTaskRelation(taskId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: CreateTaskRelationPayload) => {
      const res = await apiClient.post<ApiTaskRelation>('/task-relations/', payload);
      return mapRelation(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-relations', taskId] });
    },
  });
}

export interface UpdateTaskRelationPayload {
  id: string;
  note: string;
}

/** PATCH /api/v1/task-relations/<id>/ — edit a relation's free-text note. */
export function useUpdateTaskRelation(taskId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, note }: UpdateTaskRelationPayload) => {
      const res = await apiClient.patch<ApiTaskRelation>(`/task-relations/${id}/`, { note });
      return mapRelation(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-relations', taskId] });
    },
  });
}

/** DELETE /api/v1/task-relations/<id>/ — soft-delete a relative link. */
export function useDeleteTaskRelation(taskId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (relationId: string) => {
      await apiClient.delete(`/task-relations/${relationId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-relations', taskId] });
    },
  });
}
