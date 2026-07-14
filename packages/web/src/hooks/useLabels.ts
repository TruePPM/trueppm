/**
 * TanStack Query hooks for project-scoped task labels (ADR-0400, #1089).
 *
 * - {@link useLabels} reads the project's label catalog (`['labels', projectId]`).
 * - Catalog CRUD (create/update/delete) invalidates the catalog and, for
 *   update/delete, the board tasks cache so pills re-render with the new
 *   name/color or disappear.
 * - {@link useAttachLabel} / {@link useDetachLabel} write through the idempotent
 *   attach/detach endpoints and optimistically patch the `['tasks', projectId]`
 *   cache (already domain-shaped `Task[]`), rolling back on error and
 *   reconciling with the server (and the WS `task_updated` refetch) on settle.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { Task, TaskLabel } from '@/types';

/** A label catalog entry (domain shape). */
export interface Label {
  id: string;
  name: string;
  color: string;
  position: number;
  serverVersion: number;
}

interface ApiLabel {
  id: string;
  name: string;
  color: string;
  position: number;
  server_version: number;
  created_at?: string;
}

function mapLabel(l: ApiLabel): Label {
  return {
    id: l.id,
    name: l.name,
    color: l.color,
    position: l.position,
    serverVersion: l.server_version,
  };
}

const labelsKey = (projectId?: string) => ['labels', projectId] as const;
const tasksKey = (projectId?: string) => ['tasks', projectId] as const;

/** Read the project's label catalog (ordered by palette position). */
export function useLabels(projectId?: string) {
  return useQuery({
    queryKey: labelsKey(projectId),
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiLabel>>(
        `/projects/${projectId}/labels/`,
      );
      return res.data.results.map(mapLabel);
    },
    enabled: !!projectId,
  });
}

export interface LabelInput {
  name: string;
  color: string;
  position?: number;
}

export function useCreateLabel(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LabelInput) => {
      const res = await apiClient.post<ApiLabel>(`/projects/${projectId}/labels/`, input);
      return mapLabel(res.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: labelsKey(projectId) }),
  });
}

export function useUpdateLabel(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ labelId, ...input }: LabelInput & { labelId: string }) => {
      const res = await apiClient.patch<ApiLabel>(
        `/projects/${projectId}/labels/${labelId}/`,
        input,
      );
      return mapLabel(res.data);
    },
    onSuccess: () => {
      // Renaming/recoloring a shared label changes every card that carries it.
      void qc.invalidateQueries({ queryKey: labelsKey(projectId) });
      void qc.invalidateQueries({ queryKey: tasksKey(projectId) });
    },
  });
}

export function useDeleteLabel(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (labelId: string) => {
      await apiClient.delete(`/projects/${projectId}/labels/${labelId}/`);
    },
    onSuccess: () => {
      // The label vanishes from every card it was on — refetch the board too.
      void qc.invalidateQueries({ queryKey: labelsKey(projectId) });
      void qc.invalidateQueries({ queryKey: tasksKey(projectId) });
    },
  });
}

interface AttachContext {
  previous?: Task[];
}

/** Optimistically add `label` to `taskId`'s pills, then attach server-side. */
export function useAttachLabel(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<void, Error, { taskId: string; label: TaskLabel }, AttachContext>({
    mutationFn: async ({ taskId, label }) => {
      await apiClient.post(`/projects/${projectId}/tasks/${taskId}/labels/`, {
        label_id: label.id,
      });
    },
    onMutate: async ({ taskId, label }) => {
      await qc.cancelQueries({ queryKey: tasksKey(projectId) });
      const previous = qc.getQueryData<Task[]>(tasksKey(projectId));
      qc.setQueryData<Task[]>(tasksKey(projectId), (old) =>
        old?.map((t) =>
          t.id === taskId
            ? { ...t, labels: [...(t.labels ?? []).filter((l) => l.id !== label.id), label] }
            : t,
        ),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(tasksKey(projectId), ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: tasksKey(projectId) }),
  });
}

/** Optimistically remove `labelId` from `taskId`'s pills, then detach server-side. */
export function useDetachLabel(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<void, Error, { taskId: string; labelId: string }, AttachContext>({
    mutationFn: async ({ taskId, labelId }) => {
      await apiClient.delete(`/projects/${projectId}/tasks/${taskId}/labels/${labelId}/`);
    },
    onMutate: async ({ taskId, labelId }) => {
      await qc.cancelQueries({ queryKey: tasksKey(projectId) });
      const previous = qc.getQueryData<Task[]>(tasksKey(projectId));
      qc.setQueryData<Task[]>(tasksKey(projectId), (old) =>
        old?.map((t) =>
          t.id === taskId
            ? { ...t, labels: (t.labels ?? []).filter((l) => l.id !== labelId) }
            : t,
        ),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(tasksKey(projectId), ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: tasksKey(projectId) }),
  });
}
