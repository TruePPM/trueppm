import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Workspace lifecycle hooks (#641, ADR-0174): transfer ownership, full export
 * (async, polled), and hard delete. Mirrors the project lifecycle mutations.
 */

export type WorkspaceExportStatus = 'pending' | 'running' | 'success' | 'failed';

export interface WorkspaceExportJob {
  id: string;
  status: WorkspaceExportStatus;
  fileSize: number | null;
  errorDetail: string;
  expiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Non-null only once the archive is ready; presence = "downloadable". */
  downloadUrl: string | null;
}

interface WorkspaceExportJobRaw {
  id: string;
  status: WorkspaceExportStatus;
  file_size: number | null;
  error_detail: string;
  expires_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  download_url: string | null;
}

function mapJob(raw: WorkspaceExportJobRaw): WorkspaceExportJob {
  return {
    id: raw.id,
    status: raw.status,
    fileSize: raw.file_size,
    errorDetail: raw.error_detail,
    expiresAt: raw.expires_at,
    createdAt: raw.created_at,
    startedAt: raw.started_at,
    completedAt: raw.completed_at,
    downloadUrl: raw.download_url,
  };
}

/** POST /workspace/transfer-ownership/ — promote a member; demote the caller. */
export function useTransferWorkspaceOwnership() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newOwnerUserId: number) => {
      await apiClient.post('/workspace/transfer-ownership/', {
        new_owner_user_id: newOwnerUserId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-settings'] });
    },
  });
}

/** POST /workspace/export/ — queue a full-workspace archive job. */
export function useStartWorkspaceExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<WorkspaceExportJobRaw>('/workspace/export/');
      return mapJob(res.data);
    },
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-export', job.id] });
    },
  });
}

/**
 * GET /workspace/export/{jobId}/ — poll an export's status. Auto-polls every 3 s
 * while the job is pending/running, then stops once it is success/failed.
 */
export function useWorkspaceExportJob(jobId: string | null) {
  return useQuery({
    queryKey: ['workspace-export', jobId],
    enabled: jobId != null,
    queryFn: async () => {
      const res = await apiClient.get<WorkspaceExportJobRaw>(`/workspace/export/${jobId}/`);
      return mapJob(res.data);
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? 3000 : false;
    },
  });
}

/**
 * Download a ready export archive. The endpoint is JWT-authenticated, so we fetch
 * it through the axios client (which attaches the bearer token) as a blob and
 * trigger a client-side save — a plain anchor href would hit the endpoint
 * unauthenticated. The relative path avoids double-prefixing the `/api/v1` baseURL.
 */
export async function downloadWorkspaceExport(job: WorkspaceExportJob): Promise<void> {
  const res = await apiClient.get<Blob>(`/workspace/export/${job.id}/download/`, {
    responseType: 'blob',
    timeout: 0,
  });
  const url = URL.createObjectURL(res.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `workspace-export-${job.id}.tar.gz`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** DELETE /workspace/ — hard delete (factory reset). Confirm header = workspace name. */
export function useDeleteWorkspace() {
  return useMutation({
    mutationFn: async (confirmName: string) => {
      await apiClient.delete('/workspace/', {
        headers: { 'X-Confirm-Workspace': confirmName },
      });
    },
  });
}
