/**
 * Fetches and mutates the per-project board saved views (issue #191).
 * Translates API snake_case config keys to camelCase for consumers.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { EvmMode } from '@/features/board/BoardCard';

// Sortable fields available on the board toolbar.
export type BoardSortKey = 'priority' | 'start_date' | 'percent_complete';

/**
 * Serializable board view state — the subset of BoardView toolbar state that
 * is saved as a named view and applied from built-in presets.
 */
export interface BoardViewConfig {
  sort: BoardSortKey;
  showWip: boolean;
  showColTints: boolean;
  evmMode: EvmMode;
  showCost: boolean;
  riskLinkedOnly: boolean;
  /** Only tasks assigned to the current user. Requires /me endpoint; currently advisory. */
  assigneeFilter?: 'me' | null;
  /** Only tasks where isCritical === true. */
  cpOnly?: boolean;
  /** Only tasks with finish within N calendar days. */
  dueSoonDays?: number | null;
}

export interface BoardSavedView {
  id: string;
  name: string;
  config: BoardViewConfig;
  createdBy: string | null;
  serverVersion: number;
  createdAt: string;
  updatedAt: string;
}

// API wire format
interface ApiViewConfig {
  sort: BoardSortKey;
  show_wip: boolean;
  show_col_tints: boolean;
  evm_mode: EvmMode;
  show_cost: boolean;
  risk_linked_only: boolean;
}

interface ApiSavedView {
  id: string;
  name: string;
  config: ApiViewConfig;
  created_by: string | null;
  server_version: number;
  created_at: string;
  updated_at: string;
}

function fromApi(v: ApiSavedView): BoardSavedView {
  return {
    id: v.id,
    name: v.name,
    config: {
      sort: v.config.sort,
      showWip: v.config.show_wip,
      showColTints: v.config.show_col_tints,
      evmMode: v.config.evm_mode,
      showCost: v.config.show_cost,
      riskLinkedOnly: v.config.risk_linked_only,
    },
    createdBy: v.created_by,
    serverVersion: v.server_version,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

function toApiConfig(config: BoardViewConfig): ApiViewConfig {
  return {
    sort: config.sort,
    show_wip: config.showWip,
    show_col_tints: config.showColTints,
    evm_mode: config.evmMode,
    show_cost: config.showCost,
    risk_linked_only: config.riskLinkedOnly,
  };
}

export function useBoardSavedViews(projectId: string | null) {
  const qc = useQueryClient();
  const key = ['board-views', projectId];

  const { data, isLoading } = useQuery<BoardSavedView[]>({
    queryKey: key,
    enabled: !!projectId,
    queryFn: async () => {
      const res = await apiClient.get<ApiSavedView[]>(
        `/projects/${projectId}/board-views/`
      );
      return res.data.map(fromApi);
    },
  });

  const create = useMutation({
    mutationFn: async ({ name, config }: { name: string; config: BoardViewConfig }) => {
      const res = await apiClient.post<ApiSavedView>(
        `/projects/${projectId}/board-views/`,
        { name, config: toApiConfig(config) }
      );
      return fromApi(res.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const update = useMutation({
    mutationFn: async ({
      id,
      name,
      config,
    }: {
      id: string;
      name?: string;
      config?: BoardViewConfig;
    }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (config !== undefined) body.config = toApiConfig(config);
      const res = await apiClient.patch<ApiSavedView>(
        `/projects/${projectId}/board-views/${id}/`,
        body
      );
      return fromApi(res.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/projects/${projectId}/board-views/${id}/`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return {
    views: data ?? [],
    isLoading,
    create,
    update,
    remove,
  };
}
