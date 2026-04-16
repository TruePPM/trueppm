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
}

interface BoardConfigResponse {
  columns: BoardColumnDef[];
}

const DEFAULT_COLUMNS: BoardColumnDef[] = [
  { status: 'NOT_STARTED', label: 'TO DO', visible: true },
  { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true },
  { status: 'ON_HOLD', label: 'ON HOLD', visible: true },
  { status: 'COMPLETE', label: 'DONE', visible: true },
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
