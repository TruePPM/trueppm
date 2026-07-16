import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Async program export bundle hooks (issue 1958, ADR-0219). The program-grain
 * sibling of useProjectExport: POST enqueues a job, a polled GET tracks status
 * pending → running → success/failed, and a blob GET streams the authenticated
 * download. The bundle is a .tar.gz of the canonical program seed plus, per
 * member project, MS Project XML, attachments, time entries, and audit history.
 */

export type ProgramExportStatus = 'pending' | 'running' | 'success' | 'failed';

export interface ProgramExportJob {
  id: string;
  status: ProgramExportStatus;
  fileSize: number | null;
  errorDetail: string;
  expiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Non-null only once the archive is ready; presence = "downloadable". */
  downloadUrl: string | null;
}

interface ProgramExportJobRaw {
  id: string;
  status: ProgramExportStatus;
  file_size: number | null;
  error_detail: string;
  expires_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  download_url: string | null;
}

function mapJob(raw: ProgramExportJobRaw): ProgramExportJob {
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

/** POST /programs/{id}/export/ — queue a richer async bundle job. */
export function useStartProgramExport(programId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<ProgramExportJobRaw>(`/programs/${programId}/export/`);
      return mapJob(res.data);
    },
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: ['program-export', programId, job.id] });
    },
  });
}

/**
 * GET /programs/{id}/export/jobs/{jobId}/ — poll an export's status. Auto-polls
 * every 3 s while the job is pending/running, then stops once it is success/failed.
 */
export function useProgramExportJob(programId: string, jobId: string | null) {
  return useQuery({
    queryKey: ['program-export', programId, jobId],
    enabled: jobId != null,
    queryFn: async () => {
      const res = await apiClient.get<ProgramExportJobRaw>(
        `/programs/${programId}/export/jobs/${jobId}/`,
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
export async function downloadProgramExport(
  programId: string,
  job: ProgramExportJob,
  code?: string | null,
): Promise<void> {
  const res = await apiClient.get<Blob>(`/programs/${programId}/export/jobs/${job.id}/download/`, {
    responseType: 'blob',
    timeout: 0,
  });
  const url = URL.createObjectURL(res.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `program-${(code || programId).trim() || programId}.tar.gz`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
