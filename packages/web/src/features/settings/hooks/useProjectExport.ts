import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Async project export bundle hooks (issue 1266, ADR-0219). Mirrors the workspace
 * export hooks (useWorkspaceLifecycle) at the project grain: POST enqueues a job,
 * a polled GET tracks status pending → running → success/failed, and a blob GET
 * streams the authenticated download. The richer counterpart to the synchronous
 * JSON seed export (useExportProjectSeed) — the bundle is a .tar.gz of the JSON
 * seed, MS Project XML, attachments, time entries, and the project audit history.
 */

export type ProjectExportStatus = 'pending' | 'running' | 'success' | 'failed';

export interface ProjectExportJob {
  id: string;
  status: ProjectExportStatus;
  fileSize: number | null;
  errorDetail: string;
  expiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Non-null only once the archive is ready; presence = "downloadable". */
  downloadUrl: string | null;
}

interface ProjectExportJobRaw {
  id: string;
  status: ProjectExportStatus;
  file_size: number | null;
  error_detail: string;
  expires_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  download_url: string | null;
}

function mapJob(raw: ProjectExportJobRaw): ProjectExportJob {
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

/** POST /projects/{id}/export/ — queue a richer async bundle job. */
export function useStartProjectExport(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<ProjectExportJobRaw>(`/projects/${projectId}/export/`);
      return mapJob(res.data);
    },
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: ['project-export', projectId, job.id] });
    },
  });
}

/**
 * GET /projects/{id}/export/jobs/{jobId}/ — poll an export's status. Auto-polls
 * every 3 s while the job is pending/running, then stops once it is success/failed.
 */
export function useProjectExportJob(projectId: string, jobId: string | null) {
  return useQuery({
    queryKey: ['project-export', projectId, jobId],
    enabled: jobId != null,
    queryFn: async () => {
      const res = await apiClient.get<ProjectExportJobRaw>(
        `/projects/${projectId}/export/jobs/${jobId}/`,
      );
      return mapJob(res.data);
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? 3000 : false;
    },
  });
}

/**
 * Download a ready export bundle. The endpoint is JWT-authenticated, so we fetch
 * it through the axios client (which attaches the bearer token) as a blob and
 * trigger a client-side save — a plain anchor href would hit the endpoint
 * unauthenticated. The relative path avoids double-prefixing the `/api/v1` baseURL.
 */
export async function downloadProjectExport(
  projectId: string,
  job: ProjectExportJob,
  code?: string | null,
): Promise<void> {
  const res = await apiClient.get<Blob>(
    `/projects/${projectId}/export/jobs/${job.id}/download/`,
    { responseType: 'blob' },
  );
  const url = URL.createObjectURL(res.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `project-${(code || projectId).trim() || projectId}.tar.gz`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
