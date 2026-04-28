/**
 * Fetches and mutates the per-project board column configuration.
 * Falls back to the hardcoded 5-column default when no config is saved.
 *
 * API shape uses snake_case (wip_limit); this hook translates to camelCase
 * for consumers and back to snake_case on save.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { TaskStatus } from '@/types';

export interface BoardColumnDef {
  status: TaskStatus;
  label: string;
  visible: boolean;
  /**
   * WIP limit for this column. Null = no limit (displayed as ∞).
   * Advisory only — UI shows amber chip when over limit; never blocks drops.
   */
  wipLimit: number | null;
  /**
   * Column accent color as #RRGGBB hex, or null to use the default tint.
   * Persisted server-side per ADR-0039.
   */
  color: string | null;
  /**
   * Cycle-time SLA in calendar days. Cards in this column longer than slaDays
   * show an aging indicator (issue #192). Frontend-only — not sent to the API.
   */
  slaDays?: number;
}

// API wire format — snake_case, no slaDays
interface ApiColumn {
  status: TaskStatus;
  label: string;
  visible: boolean;
  wip_limit: number | null;
  color: string | null;
}

interface BoardConfigResponse {
  columns: ApiColumn[];
}

// slaDays are frontend-only defaults; not persisted to the server.
const COLUMN_SLA_DEFAULTS: Partial<Record<TaskStatus, number>> = {
  BACKLOG: 14,
  NOT_STARTED: 7,
  IN_PROGRESS: 10,
  REVIEW: 4,
};

// 5-column model per Claude Design handoff (issue #178).
// ON_HOLD is hidden but kept in the type union for migration compatibility — tasks
// that are ON_HOLD in the API will not appear on the board until they are migrated.
const DEFAULT_COLUMNS: BoardColumnDef[] = [
  { status: 'BACKLOG', label: 'Backlog', visible: true, wipLimit: null, color: '#94A3B8', slaDays: 14 },
  { status: 'NOT_STARTED', label: 'To Do', visible: true, wipLimit: null, color: '#64748B', slaDays: 7 },
  { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wipLimit: 5, color: '#3B82F6', slaDays: 10 },
  { status: 'REVIEW', label: 'Review', visible: true, wipLimit: 3, color: '#A855F7', slaDays: 4 },
  { status: 'COMPLETE', label: 'Done', visible: true, wipLimit: null, color: '#22C55E' },
];

function fromApi(col: ApiColumn): BoardColumnDef {
  return {
    status: col.status,
    label: col.label,
    visible: col.visible,
    wipLimit: col.wip_limit,
    color: col.color,
    slaDays: COLUMN_SLA_DEFAULTS[col.status],
  };
}

function toApi(col: BoardColumnDef): ApiColumn {
  return {
    status: col.status,
    label: col.label,
    visible: col.visible,
    wip_limit: col.wipLimit,
    color: col.color,
  };
}

async function fetchBoardConfig(projectId: string): Promise<BoardColumnDef[]> {
  const resp = await apiClient.get<BoardConfigResponse>(`/projects/${projectId}/board-config/`);
  return resp.data.columns.map(fromApi);
}

async function saveBoardConfig(projectId: string, columns: BoardColumnDef[]): Promise<BoardColumnDef[]> {
  const resp = await apiClient.put<BoardConfigResponse>(`/projects/${projectId}/board-config/`, {
    columns: columns.map(toApi),
  });
  return resp.data.columns.map(fromApi);
}

export function useBoardConfig(projectId: string | null | undefined): {
  columns: BoardColumnDef[];
  isLoading: boolean;
  save: (columns: BoardColumnDef[]) => Promise<void>;
} {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['boardConfig', projectId],
    queryFn: () => fetchBoardConfig(projectId!),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: (columns: BoardColumnDef[]) => saveBoardConfig(projectId!, columns),
    onSuccess: (result) => {
      queryClient.setQueryData(['boardConfig', projectId], result);
    },
  });

  return {
    columns: data ?? DEFAULT_COLUMNS,
    isLoading,
    save: async (columns) => {
      await mutation.mutateAsync(columns);
    },
  };
}
