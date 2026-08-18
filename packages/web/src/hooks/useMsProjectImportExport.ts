import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Default per-file upload cap (MB) shown in the import UI.
 *
 * Mirrors the server default `settings.MSPROJECT_MAX_UPLOAD_MB`. The server is
 * authoritative: when a deployment overrides the cap, the import view's 400
 * response carries the real limit and the modal surfaces that message
 * verbatim. This constant only drives the instant client-side pre-check and
 * the dropzone copy (the handoff's "soft cap" model).
 */
export const MS_PROJECT_MAX_UPLOAD_MB = 50;

/**
 * File extensions the MS Project **import UI** offers.
 *
 * `.xml` only, deliberately (#2891). The server endpoint still accepts `.mpp` —
 * that is the documented operator escape hatch, and it is unchanged — but `.mpp`
 * parsing needs the optional MPXJ JAR and a Java runtime, and the reference image
 * bundles neither. `MPXJ_JAR_PATH` is not even a declared setting; the parser
 * reads it through a `getattr` default. So on a stock deployment a `.mpp` upload
 * 202s and then dead-letters in the worker with "MPXJ JAR not found", and
 * `ImportRequest` has no field to carry that reason back (#2714) — the user sees
 * an import that never lands and no explanation.
 *
 * Offering it here also disagreed with the two surfaces beside it: the
 * create-from-import dialog accepted `.xml` only, and `FormatPicker` rendered
 * `.mpp` disabled and "planned for 0.6". Three answers to one question is worse
 * than any one of them. First-class `.mpp` support is #128, sequenced for 0.6;
 * until then the UI says `.xml` everywhere and the API keeps the escape hatch for
 * operators who install the toolchain (`administration/msproject-configuration`).
 */
export const MS_PROJECT_ACCEPT = ['.xml'] as const;

interface ImportResponse {
  detail: string;
  /** ID of the ImportRequest outbox row; the import runs async via Celery. */
  import_request_id: string;
}

/**
 * POST /api/v1/projects/:id/import/msproject/ — upload a .xml (MSPDI) file.
 *
 * The import runs asynchronously (transactional outbox → Celery), so the 202
 * response only confirms the file was queued — tasks appear once the worker
 * finishes. On success we invalidate the schedule queries so the Gantt
 * refetches when the import lands. Live progress is deferred to #61.
 */
export function useImportMsProject(projectId: string | null | undefined) {
  const queryClient = useQueryClient();

  return useMutation<ImportResponse, Error, File>({
    mutationFn: async (file: File) => {
      if (!projectId) throw new Error('projectId is required');
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await apiClient.post<ImportResponse>(
        `/projects/${projectId}/import/msproject/`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 },
      );
      return res.data;
    },
    onSuccess: () => {
      if (!projectId) return;
      // The import worker writes tasks + dependencies; refetch both so the
      // schedule reflects the imported rows once the queue drains.
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['dependencies', projectId] });
    },
  });
}

interface CreateFromImportVars {
  file: File;
  /** Optional program UUID — assigns the new project to a program on create. */
  programId?: string;
}

interface CreateFromImportResponse {
  queued: boolean;
  /** UUID of the project shell created synchronously; navigate here at once. */
  project_id: string;
  /** ID of the ImportRequest outbox row tracking the async task import. */
  import_request_id: string;
}

/**
 * POST /api/v1/projects/import/msproject/ — create a NEW project from a file.
 *
 * Distinct from {@link useImportMsProject}, which imports into an existing
 * project. The 202 returns the new `project_id` immediately (the shell is
 * created synchronously, named from the filename); tasks populate async via the
 * outbox, and the worker overwrites the name/dates from the file header
 * (ADR-0092). Callers navigate to `project_id` and watch its import TaskRun for
 * the terminal success/failure state. Invalidates the projects list so the new
 * project appears without a manual refetch.
 */
export function useCreateProjectFromImport() {
  const queryClient = useQueryClient();

  return useMutation<CreateFromImportResponse, Error, CreateFromImportVars>({
    mutationFn: async ({ file, programId }: CreateFromImportVars) => {
      const form = new FormData();
      form.append('file', file, file.name);
      if (programId) form.append('program', programId);
      const res = await apiClient.post<CreateFromImportResponse>(
        '/projects/import/msproject/',
        form,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 },
      );
      return res.data;
    },
    onSuccess: (_data, { programId }) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      if (programId) {
        void queryClient.invalidateQueries({ queryKey: ['programs', programId, 'projects'] });
      }
    },
  });
}

/** Parse `filename="…"` out of a Content-Disposition header, if present. */
function filenameFromDisposition(disposition: unknown): string | null {
  if (typeof disposition !== 'string') return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return match ? decodeURIComponent(match[1]) : null;
}

interface ExportState {
  /** Trigger a synchronous download of the project's MS Project XML. */
  exportProject: () => Promise<void>;
  isExporting: boolean;
  error: string | null;
}

/**
 * GET /api/v1/projects/:id/export/msproject.xml — download the schedule as
 * MS Project XML. The server streams the file with a Content-Disposition
 * filename, which we honor; we fall back to `project-<id>.xml` otherwise.
 *
 * Returns `isExporting` so callers can show a "Preparing export…" affordance
 * for slow exports.
 */
export function useExportMsProject(projectId: string | null | undefined): ExportState {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportProject = useCallback(async () => {
    if (!projectId) return;
    setIsExporting(true);
    setError(null);
    try {
      const res = await apiClient.get<Blob>(`/projects/${projectId}/export/msproject.xml`, {
        responseType: 'blob',
        timeout: 0,
      });
      const blob = new Blob([res.data], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download =
        filenameFromDisposition(res.headers['content-disposition']) ?? `project-${projectId}.xml`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Export failed. Please try again.');
    } finally {
      setIsExporting(false);
    }
  }, [projectId]);

  return { exportProject, isExporting, error };
}
