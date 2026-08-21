import { useMutation, useQuery, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { downloadCsv, escapeField } from '@/utils/exportCsv';

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
  /** Source column the problem came from, when it is scoped to one. */
  column?: string | null;
  /**
   * Stable, machine-readable cause. Never localized, so it — not the message —
   * is what "group these by cause" may key on (ADR-0634).
   */
  code?: string;
  /** `error` = the row is parked for review; `warning` = it imported degraded. */
  severity?: string;
  [key: string]: unknown;
}

/** A column exactly as it arrives on the wire, before {@link normalizeColumns}. */
export interface CsvColumnMappingWire extends Omit<CsvColumnMapping, 'field'> {
  field: string | null;
}

/**
 * The date conventions a caller may assert on the import endpoints (#2926).
 *
 * `auto` is the shipped behavior — the server scans the file and settles the
 * order from the first self-identifying value. The other three are the operator
 * asserting what their own export uses, which is the only thing that can
 * resolve a file where every value reads validly both ways.
 */
export type CsvDateOrder = 'auto' | 'mdy' | 'dmy' | 'iso';

/** Display labels for {@link CsvDateOrder}, in the order the control shows them. */
export const CSV_DATE_ORDERS: { value: CsvDateOrder; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'mdy', label: 'M/D/Y' },
  { value: 'dmy', label: 'D/M/Y' },
  { value: 'iso', label: 'ISO' },
];

/** The label a resolved (never `auto`) order renders as, inside a sentence. */
export const CSV_DATE_ORDER_NAMES: Record<string, string> = {
  mdy: 'M/D/Y (month first)',
  dmy: 'D/M/Y (day first)',
  iso: 'ISO 8601 (YYYY-MM-DD)',
};

/**
 * The value that settled the convention, and why.
 *
 * The whole point of the feature: a statement that names a row, a column and a
 * value can be checked against the file in five seconds, and "dates were
 * interpreted as M/D/Y" cannot. The server has always known this and discarded
 * it into a rendered sentence; it now crosses the API boundary intact.
 */
export interface CsvDateEvidence {
  row: number;
  column: string;
  value: string;
  /**
   * Why the value settled it. Widened to `string` on purpose: the client picks
   * a clause per known reason and falls back for anything the server adds
   * later, so a new reason degrades to a generic sentence rather than a build
   * break or a blank statement.
   */
  reason: string;
}

/** What one convention does to this file — the ambiguous state's comparison. */
export interface CsvDateReading {
  order: CsvDateOrder;
  sample_row: number | null;
  sample_name: string;
  sample_raw_start: string;
  start: string | null;
  finish: string | null;
  /** Inclusive of both endpoints — 3 Apr → 5 Apr is 3, matching the import. */
  duration_days: number | null;
  values_matched: number;
  values_failed: number;
  rows_unparseable: number;
}

/** One row as the preview table renders it: raw cell, reading, and duration. */
export interface CsvDatePreviewRow {
  row: number;
  name: string;
  raw_start: string;
  raw_finish: string;
  start: string | null;
  finish: string | null;
  duration_days: number | null;
  /** A cell that was present and would not parse under the chosen order. */
  unreadable: boolean;
}

export interface CsvPreview {
  filename: string;
  headers: string[];
  columns: CsvColumnMappingWire[];
  sample_rows: string[][];
  row_count: number;
  truncated_rows: number;
  /** The plan only — the Import review branch is counted by `parked_row_count`. */
  task_count: number;
  resource_count: number;
  /** Rows that cannot become plan tasks and will be parked for review (#2732). */
  parked_row_count?: number;
  /** Name of the summary task those rows land under. */
  review_branch_name?: string;
  row_errors: CsvRowIssue[];
  /** Rows that would NOT join the plan — parked for review, not dropped. */
  error_count: number;
  /** Rows that would land with a field defaulted. */
  warning_count: number;
  warnings: string[];
  /** What the caller asked for. */
  date_order?: CsvDateOrder;
  /** What will actually be used — never `auto`. */
  date_order_resolved?: Exclude<CsvDateOrder, 'auto'>;
  /** What `auto` would have chosen; the override copy names both. */
  date_order_auto?: Exclude<CsvDateOrder, 'auto'>;
  /** True only when auto had a real decision to make and no evidence for it. */
  date_order_ambiguous?: boolean;
  date_order_evidence?: CsvDateEvidence | null;
  /** False when no column is mapped to a date field — the control is inert. */
  date_order_has_columns?: boolean;
  /** Populated only for the ambiguous file, which needs both readings to decide. */
  date_order_readings?: CsvDateReading[];
  values_matched?: number;
  values_failed?: number;
  date_preview?: CsvDatePreviewRow[];
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
    /** Every row written, the Import review branch included. */
    tasks_created?: number;
    /** The plan alone — what "imported N tasks" is allowed to claim (#2732). */
    plan_tasks_created?: number;
    /** Rows parked in the review branch instead of dropped. */
    parked_row_count?: number;
    /** Name of the summary task they landed under, or '' when none did. */
    review_branch_name?: string;
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

function buildForm(
  file: File,
  columnMap?: Record<string, string>,
  dateOrder?: CsvDateOrder,
  dateOrderConfirmed?: boolean,
): FormData {
  const form = new FormData();
  form.append('file', file);
  // Sent as a JSON *string*: that is what a browser FormData produces, and the
  // server parses both that and a real dict.
  if (columnMap && Object.keys(columnMap).length > 0) {
    form.append('column_map', JSON.stringify(columnMap));
  }
  // Omitted when 'auto' so an untouched control sends nothing and the request is
  // byte-identical to the shipped one — the server's default is the same value,
  // and a redundant field would make every existing fixture look changed.
  if (dateOrder && dateOrder !== 'auto') {
    form.append('date_order', dateOrder);
  }
  if (dateOrderConfirmed) {
    form.append('date_order_confirmed', 'true');
  }
  return form;
}

/** What both the preview and the commit call carry. */
export interface CsvImportVars {
  file: File;
  columnMap?: Record<string, string>;
  dateOrder?: CsvDateOrder;
  /** Records that a human accepted a convention on a file that identified none. */
  dateOrderConfirmed?: boolean;
}

/** Parse a spreadsheet and return the detected mapping. Persists nothing. */
export function useCsvImportPreview(
  projectId: string | null,
): UseMutationResult<CsvPreview, Error, CsvImportVars> {
  return useMutation<CsvPreview, Error, CsvImportVars>({
    mutationFn: async ({ file, columnMap, dateOrder }) => {
      const res = await apiClient.post<CsvPreview>(
        `/projects/${projectId}/import/csv/preview/`,
        buildForm(file, columnMap, dateOrder),
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 },
      );
      return res.data;
    },
  });
}

/** Commit the import. Resolves once the outbox row is queued, not imported. */
export function useCsvImportCommit(
  projectId: string | null,
): UseMutationResult<CsvCommitResponse, Error, CsvImportVars> {
  return useMutation<CsvCommitResponse, Error, CsvImportVars>({
    mutationFn: async ({ file, columnMap, dateOrder, dateOrderConfirmed }) => {
      const res = await apiClient.post<CsvCommitResponse>(
        `/projects/${projectId}/import/csv/`,
        buildForm(file, columnMap, dateOrder, dateOrderConfirmed),
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 },
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

/**
 * `{header: field}` for a re-preview, carrying **only** the columns the operator
 * actually changed.
 *
 * Sending the whole mapping back would launder every un-reviewed guess: the
 * server marks any pinned column `override`, so one "Re-check mapping" would
 * turn nine untouched `fuzzy` columns into "Your choice" and drain the
 * flagged-column count to zero without anyone having looked at them (web-rule
 * 289). Untouched columns are left out so they get re-detected honestly and keep
 * reading as guesses.
 *
 * An explicit "Don't import" is sent as `''` rather than omitted — the server
 * resolves that to a deliberate no-mapping, whereas omitting it would let
 * auto-detection put the column straight back.
 */
export function overrideMap(
  columns: CsvColumnMapping[],
  changed: ReadonlySet<number>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of columns) {
    if (changed.has(c.index)) out[c.header] = c.field;
  }
  return out;
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

/**
 * Human label per diagnostic `code`.
 *
 * Keyed on the code rather than on the message on purpose: a code is a contract
 * and never localized, while the message embeds the offending value and is free
 * to change (ADR-0634). That is what makes "group these by cause" possible at
 * all — grouping on message text would put every bad date in its own group.
 */
const ISSUE_CAUSE_LABELS: Record<string, string> = {
  missing_name: 'No task name',
  bad_date: 'Unreadable date',
  bad_duration: 'Unreadable duration',
  bad_percent: 'Unreadable progress',
  unknown_predecessor: 'Predecessor matches no row',
  self_dependency: 'Row depends on itself',
  finish_before_start: 'Finish before start',
  excessive_indent_depth: 'Indent too deep',
};

/** `some_new_code` → `Some new code`, for a cause this build has no label for. */
function humanizeCode(code: string): string {
  const spaced = code.replaceAll('_', ' ').trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : 'Problem';
}

/** One cause, the rows it affected, and one example of what it said. */
export interface CsvIssueGroup {
  key: string;
  label: string;
  rows: number[];
  /** The first message in the group — the concrete instance behind the label. */
  example: string;
}

/**
 * Fold per-row diagnostics into one entry per cause, largest group first.
 *
 * A 400-row sheet with one wrong date format produces 400 identical-looking
 * lines, and scrolling them tells the operator nothing the first line did not.
 * Grouping turns that into "Unreadable date — 400 rows", which is the shape of
 * the single edit that fixes it.
 *
 * Issues with no `code` (an older server, or a hand-built fixture) fall back to
 * grouping on the message, which degrades to one group per distinct text rather
 * than collapsing unrelated problems together.
 */
export function groupIssuesByCause(issues: CsvRowIssue[]): CsvIssueGroup[] {
  const groups = new Map<string, CsvIssueGroup>();
  for (const issue of issues) {
    const key = issue.code ?? issue.message;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(issue.row);
      continue;
    }
    groups.set(key, {
      key,
      label: issue.code
        ? (ISSUE_CAUSE_LABELS[issue.code] ?? humanizeCode(issue.code))
        : issue.message,
      rows: [issue.row],
      example: issue.message,
    });
  }
  // Descending by size so the one edit that fixes the most rows is read first;
  // ties keep first-seen order, which is file order.
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length);
}

/** Filename the browser saves the error-row export under. */
export const CSV_IMPORT_ERRORS_FILENAME = 'trueppm-import-problems.csv';

/**
 * Render the diagnostics as a CSV the operator can open next to their sheet.
 *
 * Built client-side from the payload already in hand rather than through a new
 * endpoint: the server has no state to re-read once the import is terminal, and
 * a download that needs an id would stop working the moment the wizard closed.
 * Cells go through the shared `escapeField`, so a message quoting a
 * formula-injection task name cannot execute when this file is opened (#2762).
 */
export function issuesToCsvString(issues: CsvRowIssue[]): string {
  const rows = ['Row,Column,Severity,Cause,Message'];
  for (const issue of issues) {
    rows.push(
      [
        String(issue.row),
        escapeField(issue.column ?? ''),
        escapeField(issue.severity ?? ''),
        escapeField(issue.code ?? ''),
        escapeField(issue.message),
      ].join(','),
    );
  }
  return rows.join('\r\n');
}

/** Save {@link issuesToCsvString} as a download. */
export function downloadIssuesCsv(issues: CsvRowIssue[]): void {
  downloadCsv(issuesToCsvString(issues), CSV_IMPORT_ERRORS_FILENAME);
}
