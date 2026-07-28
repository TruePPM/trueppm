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

/**
 * How a column arrived at the field it is mapped to.
 *
 * `duplicate` is the one that needs explaining: when two source columns claim
 * the same field the loser comes back with `field: null`, and without surfacing
 * the reason that column just looks mysteriously unmapped.
 */
export type CsvMappingConfidence = 'exact' | 'fuzzy' | 'none' | 'duplicate' | 'override';

/** One detected source column and the field it will import into. */
export interface CsvColumnMapping {
  index: number;
  header: string;
  /**
   * Target field key, or '' when the column will be ignored. The server sends
   * `null` for an unmatched or duplicate column, which {@link normalizeColumns}
   * folds to '' so the wizard's `<select>` stays controlled.
   */
  field: string;
  confidence: CsvMappingConfidence;
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

/** A column exactly as it arrives on the wire, before {@link normalizeColumns}. */
export interface CsvColumnMappingWire extends Omit<CsvColumnMapping, 'field'> {
  field: string | null;
}

export interface CsvPreview {
  filename: string;
  headers: string[];
  columns: CsvColumnMappingWire[];
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

/** Filename the browser saves the template under. */
export const CSV_IMPORT_TEMPLATE_FILENAME = 'trueppm-import-template.csv';

/**
 * Download the known-good CSV template.
 *
 * The endpoint is JWT-authenticated, so a plain `<a href download>` would reach
 * it with no Authorization header and get a 401 — it has to be fetched as a blob
 * through the axios client and saved client-side, the same way the project
 * export bundle is. The path is deliberately not project-scoped: the template is
 * static content that step 1 offers before a project context is even needed.
 */
export function useCsvImportTemplate(): UseMutationResult<void, Error, void> {
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      const res = await apiClient.get<Blob>('/import-templates/csv/', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = CSV_IMPORT_TEMPLATE_FILENAME;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
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

/**
 * Fold the wire's `field: null` to `''`.
 *
 * The server returns `null` for a column it could not match and for the loser of
 * a duplicate claim. Feeding that straight into `<select value={…}>` would flip
 * the control to uncontrolled on the first such column, so the boundary is
 * normalized once here rather than defended at every read site.
 */
export function normalizeColumns(columns: CsvColumnMappingWire[]): CsvColumnMapping[] {
  return columns.map((c) => ({ ...c, field: c.field ?? '' }));
}

/** Columns the server guessed at or dropped — the ones worth an operator's eye. */
export function flaggedColumns(columns: CsvColumnMapping[]): CsvColumnMapping[] {
  return columns.filter((c) => c.confidence === 'fuzzy' || c.confidence === 'duplicate');
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
