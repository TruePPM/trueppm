import { useMutation, useQuery, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * CSV / Excel import wizard data layer (#746, ADR-0632).
 *
 * Three server calls behind the 3-step wizard:
 *
 * 1. `POST …/import/csv/preview/` — parse and return the detected mapping plus
 *    ten sample rows, **persisting nothing**. Re-run on every remap so the
 *    preview the operator confirms is the one the server actually produced,
 *    rather than a client-side guess at what a remap would do.
 * 2. `POST …/import/csv/` — commit. Returns `202 {queued, import_request_id}`,
 *    **not** a Celery task id: the server writes an outbox row before dispatch,
 *    so there is no synchronous task handle to hand back (ADR-0632).
 * 3. `GET …/import/csv/{id}/` — poll that row to a terminal state.
 *
 * Nothing is held server-side between steps; the mapping lives in wizard state,
 * so a failed commit can be retried without a draft to resume or expire.
 */

/** Accepted upload extensions — mirrors the server's `SUPPORTED_EXTENSIONS`. */
export const CSV_IMPORT_ACCEPT = ['.csv', '.tsv', '.txt', '.xlsx', '.xlsm'] as const;

/**
 * Client-side size guard, mirroring `CSV_IMPORT_MAX_UPLOAD_MB` (default 10).
 * The server enforces the authoritative limit; this only spares the operator a
 * multipart round-trip that is certain to be rejected.
 */
export const CSV_IMPORT_MAX_UPLOAD_MB = 10;

/** One detected source column and the field it will import into. */
export interface CsvColumnMapping {
  index: number;
  header: string;
  /** Target field key, or '' when the column will be ignored. */
  field: string;
  /** Fuzzy-match confidence 0..1 for the auto-detected field. */
  confidence: number;
}

/** A target field the wizard's dropdown can offer for a column. */
export interface CsvTargetField {
  field: string;
  label: string;
  required: boolean;
  /** Whether more than one source column may map to this field (e.g. labels). */
  multi: boolean;
}

/** A per-row parse problem, addressed by spreadsheet line number. */
export interface CsvRowIssue {
  row: number;
  message: string;
  [key: string]: unknown;
}

export interface CsvPreview {
  filename: string;
  headers: string[];
  columns: CsvColumnMapping[];
  sample_rows: string[][];
  row_count: number;
  truncated_rows: number;
  task_count: number;
  resource_count: number;
  row_errors: CsvRowIssue[];
  /** Rows that would be LOST. */
  error_count: number;
  /** Rows that would land with a field defaulted. */
  warning_count: number;
  warnings: string[];
  available_fields: CsvTargetField[];
}

export interface CsvCommitResponse {
  detail: string;
  queued: boolean;
  import_request_id: string;
}

export interface CsvImportStatusResponse {
  id: string;
  /** Outbox lifecycle: pending → dispatched → done | dead. */
  status: 'pending' | 'dispatched' | 'done' | 'dead';
  filename: string;
  summary: {
    tasks_created?: number;
    resources_created?: number;
    dependencies_created?: number;
    rows_read?: number;
    rows_skipped?: number;
    row_errors?: CsvRowIssue[];
    row_error_count?: number;
    error_count?: number;
    warning_count?: number;
    warnings?: string[];
    error?: string;
  } | null;
  requested_at: string;
}

function buildForm(file: File, columnMap?: Record<string, string>): FormData {
  const form = new FormData();
  form.append('file', file);
  // Sent as a JSON *string*: that is what a browser FormData produces, and the
  // server parses both that and a real dict.
  if (columnMap && Object.keys(columnMap).length > 0) {
    form.append('column_map', JSON.stringify(columnMap));
  }
  return form;
}

/** Parse a spreadsheet and return the detected mapping. Persists nothing. */
export function useCsvImportPreview(
  projectId: string | null,
): UseMutationResult<CsvPreview, Error, { file: File; columnMap?: Record<string, string> }> {
  return useMutation<CsvPreview, Error, { file: File; columnMap?: Record<string, string> }>({
    mutationFn: async ({ file, columnMap }) => {
      const res = await apiClient.post<CsvPreview>(
        `/projects/${projectId}/import/csv/preview/`,
        buildForm(file, columnMap),
      );
      return res.data;
    },
  });
}

/** Commit the import. Resolves once the outbox row is queued, not imported. */
export function useCsvImportCommit(
  projectId: string | null,
): UseMutationResult<CsvCommitResponse, Error, { file: File; columnMap?: Record<string, string> }> {
  return useMutation<CsvCommitResponse, Error, { file: File; columnMap?: Record<string, string> }>({
    mutationFn: async ({ file, columnMap }) => {
      const res = await apiClient.post<CsvCommitResponse>(
        `/projects/${projectId}/import/csv/`,
        buildForm(file, columnMap),
      );
      return res.data;
    },
  });
}

/**
 * Poll one import to a terminal state.
 *
 * Polls every 1.5 s while the row is `pending`/`dispatched` and stops on
 * `done`/`dead`. Disabled until an id exists, so the wizard's earlier steps
 * issue no requests.
 */
export function useCsvImportStatus(projectId: string | null, importId: string | null) {
  return useQuery<CsvImportStatusResponse, Error>({
    queryKey: ['csv-import-status', projectId, importId],
    enabled: Boolean(projectId) && Boolean(importId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'done' || status === 'dead' ? false : 1500;
    },
    queryFn: async () => {
      const res = await apiClient.get<CsvImportStatusResponse>(
        `/projects/${projectId}/import/csv/${importId}/`,
      );
      return res.data;
    },
  });
}

/**
 * Required target fields that no column maps to.
 *
 * Drives the Next-blocking reason on the mapping step: an import missing its
 * name column silently produces zero tasks, which is the failure ADR-0632 says
 * preview exists to prevent reaching commit.
 */
export function missingRequiredFields(
  columns: CsvColumnMapping[],
  available: CsvTargetField[],
): CsvTargetField[] {
  const mapped = new Set(columns.map((c) => c.field).filter(Boolean));
  return available.filter((f) => f.required && !mapped.has(f.field));
}

/** `{header: field}` for the wire, skipping columns the operator ignored. */
export function toColumnMap(columns: CsvColumnMapping[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of columns) {
    if (c.field) out[c.header] = c.field;
  }
  return out;
}

/** Headers the operator left unmapped — surfaced before commit, never silently dropped. */
export function unmappedHeaders(columns: CsvColumnMapping[]): string[] {
  return columns.filter((c) => !c.field).map((c) => c.header);
}
