/**
 * CRUD hook for project phases (root-level WBS tasks) — surface for the
 * Project Settings → Workflow page (#521).
 *
 * Phases are listed/created/updated/deleted via /projects/:id/phases/. The
 * pre-existing /projects/:id/phases/reorder/ endpoint (ADR-0046) still owns
 * batched reordering with optimistic locking on server_version.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export interface ProjectPhase {
  id: string;
  name: string;
  color: string | null;
  priorityRank: number | null;
  wbsPath: string | null;
  taskCount: number;
  serverVersion: number;
}

interface ApiPhase {
  id: string;
  name: string;
  color: string | null;
  priority_rank: number | null;
  wbs_path: string | null;
  task_count: number;
  server_version: number;
}

function fromApi(row: ApiPhase): ProjectPhase {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    priorityRank: row.priority_rank,
    wbsPath: row.wbs_path,
    taskCount: row.task_count,
    serverVersion: row.server_version,
  };
}

export interface CreatePhasePayload {
  name: string;
  color?: string | null;
}

export interface UpdatePhasePayload {
  name?: string;
  color?: string | null;
}

const PHASES_KEY = (projectId: string) => ['project-phases', projectId] as const;

export function useProjectPhases(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const enabled = Boolean(projectId);

  const query = useQuery({
    queryKey: PHASES_KEY(projectId ?? ''),
    queryFn: async () => {
      const res = await apiClient.get<ApiPhase[]>(`/projects/${projectId}/phases/`);
      return res.data.map(fromApi);
    },
    enabled,
    staleTime: 30_000,
  });

  const create = useMutation({
    mutationFn: async (payload: CreatePhasePayload) => {
      const res = await apiClient.post<ApiPhase>(`/projects/${projectId}/phases/`, {
        name: payload.name,
        color: payload.color ?? null,
      });
      return fromApi(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PHASES_KEY(projectId ?? '') });
    },
  });

  const update = useMutation({
    mutationFn: async (args: { id: string; payload: UpdatePhasePayload }) => {
      const res = await apiClient.patch<ApiPhase>(
        `/projects/${projectId}/phases/${args.id}/`,
        args.payload,
      );
      return fromApi(res.data);
    },
    onSuccess: (row) => {
      queryClient.setQueryData<ProjectPhase[] | undefined>(
        PHASES_KEY(projectId ?? ''),
        (prev) => prev?.map((p) => (p.id === row.id ? row : p)),
      );
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/projects/${projectId}/phases/${id}/`);
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<ProjectPhase[] | undefined>(
        PHASES_KEY(projectId ?? ''),
        (prev) => prev?.filter((p) => p.id !== id),
      );
    },
  });

  // Reorder uses the dedicated /phases/reorder/ endpoint (ADR-0046) — batch
  // update of priority_rank with optimistic-lock check on server_version.
  const reorder = useMutation({
    mutationFn: async (orderedIds: string[]) => {
      const current = query.data ?? [];
      const byId = new Map(current.map((p) => [p.id, p]));
      const phasesPayload = orderedIds
        .map((id) => byId.get(id))
        .filter((p): p is ProjectPhase => p !== undefined)
        .map((p) => ({ id: p.id, server_version: p.serverVersion }));
      await apiClient.patch(`/projects/${projectId}/phases/reorder/`, {
        phases: phasesPayload,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PHASES_KEY(projectId ?? '') });
    },
  });

  return {
    phases: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    create,
    update,
    remove,
    reorder,
  };
}
