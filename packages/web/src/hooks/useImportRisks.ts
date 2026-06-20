import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Client-side pre-check cap (MB) for the risk CSV import. The server is
 * authoritative — its 400 carries the real limit and the modal shows that
 * message verbatim — this only drives the instant dropzone pre-check.
 */
export const RISK_IMPORT_MAX_UPLOAD_MB = 2;

/** File extensions the risk import endpoint accepts. */
export const RISK_IMPORT_ACCEPT = ['.csv'] as const;

/** One per-row problem returned by the import — a skipped error or a coercion warning. */
export interface RiskImportIssue {
  row: number;
  field: string;
  message: string;
}

/** Result of a synchronous risk CSV import (issue 223, ADR-0043 addendum). */
export interface RiskImportResult {
  imported: number;
  skipped: number;
  errors: RiskImportIssue[];
  warnings: RiskImportIssue[];
}

/**
 * POST /api/v1/projects/:id/risks/import/ — upload a risk-register CSV.
 *
 * Unlike the MS Project import (async via Celery), this runs synchronously and
 * returns the per-row outcome immediately, so the modal can show imported /
 * skipped counts plus the error and warning lists. On any success we invalidate
 * the risks cache so the register reflects the new rows; the server also emits a
 * single `risks_imported` board event for collaborators (see useProjectWebSocket).
 */
export function useImportRisks(projectId: string | null | undefined) {
  const queryClient = useQueryClient();

  return useMutation<RiskImportResult, Error, File>({
    mutationFn: async (file: File) => {
      if (!projectId) throw new Error('projectId is required');
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await apiClient.post<RiskImportResult>(
        `/projects/${projectId}/risks/import/`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      return res.data;
    },
    onSuccess: (result) => {
      // Only refetch when something actually landed (an all-invalid file
      // returns 200 with imported: 0 and nothing to refresh).
      if (!projectId || result.imported === 0) return;
      void queryClient.invalidateQueries({ queryKey: ['risks', projectId] });
    },
  });
}
