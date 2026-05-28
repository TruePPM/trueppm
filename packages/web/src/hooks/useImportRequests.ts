/**
 * Hook for GET /api/v1/projects/{pk}/imports/ — import provenance list (#799).
 *
 * Read-only audit list of MS Project (and future format) import attempts
 * for a project: filename, who initiated it, when, status, and task count.
 * Member+ on the project. Rows are purged after 7 days
 * (`purge_old_import_requests`), so this is a recent-activity view, not a
 * durable audit log — durable audit lives on the enterprise overlay.
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

// ---------------------------------------------------------------------------
// API response shapes (hand-declared; do NOT edit src/api/types.ts).
// ---------------------------------------------------------------------------

export type ImportRequestStatus = 'pending' | 'dispatched' | 'done' | 'dead';

export interface ImportProvenanceRow {
  id: string;
  filename: string;
  status: ImportRequestStatus;
  creates_project: boolean;
  requested_at: string;
  /** PK of the user who initiated the import; null when the user was deleted. */
  initiated_by: number | null;
  /** Display username; null when initiated_by is null. */
  initiated_by_username: string | null;
  /**
   * Tasks created by the import, read from the linked TaskRun summary.
   * Null until the worker writes its summary (PENDING / DISPATCHED rows) or
   * when an import failed before any tasks were created.
   */
  task_count: number | null;
}

interface ListResponse {
  results: ImportProvenanceRow[];
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * List recent import requests for a project, newest first.
 *
 * Returns an empty array when no imports have been recorded — the consumer
 * should treat empty as "hide the provenance UI". The query is disabled
 * when projectId is undefined.
 */
export function useImportRequests(projectId: string | undefined) {
  return useQuery<ImportProvenanceRow[]>({
    queryKey: ['project-imports', projectId],
    queryFn: async () => {
      const res = await apiClient.get<ListResponse>(`/projects/${projectId}/imports/`);
      return res.data.results;
    },
    enabled: !!projectId,
  });
}
