/**
 * Fetches and mutates the per-project board column configuration.
 * Falls back to the hardcoded 4-column default when no config is saved.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { TaskStatus } from '@/types';

export interface BoardColumnDef {
  status: TaskStatus;
  label: string;
  visible: boolean;
  /**
   * WIP limit for this column. Undefined = no limit (displayed as ∞).
   * Stored in the board config so PMs can set it per project.
   */
  wipLimit?: number;
  /**
   * Cycle-time SLA in calendar days. Cards that have been in this column
   * longer than slaDays show an aging indicator (issue #192).
   * Undefined = no SLA enforced for this column.
   */
  slaDays?: number;
}

interface BoardConfigResponse {
  columns: BoardColumnDef[];
}

// 5-column model per Claude Design handoff (issue #178).
// Backlog = in project, unassigned/unestimated (idea state).
// ON_HOLD is hidden but kept in the type union for migration compatibility — tasks
// that are ON_HOLD in the API will not appear on the board until they are migrated.
const DEFAULT_COLUMNS: BoardColumnDef[] = [
  { status: 'BACKLOG',     label: 'Backlog',     visible: true, slaDays: 14 },
  { status: 'NOT_STARTED', label: 'To Do',       visible: true, slaDays: 7  },
  { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wipLimit: 3, slaDays: 10 },
  { status: 'REVIEW',      label: 'Review',      visible: true, wipLimit: 2, slaDays: 4  },
  { status: 'COMPLETE',    label: 'Done',        visible: true },
];

async function fetchBoardConfig(projectId: string): Promise<BoardConfigResponse> {
  const resp = await apiClient.get<BoardConfigResponse>(`/projects/${projectId}/board-config/`);
  return resp.data;
}

async function saveBoardConfig(
  projectId: string,
  columns: BoardColumnDef[],
): Promise<BoardConfigResponse> {
  const resp = await apiClient.put<BoardConfigResponse>(`/projects/${projectId}/board-config/`, {
    columns,
  });
  return resp.data;
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
    columns: data?.columns ?? DEFAULT_COLUMNS,
    isLoading,
    save: async (columns) => {
      await mutation.mutateAsync(columns);
    },
  };
}
