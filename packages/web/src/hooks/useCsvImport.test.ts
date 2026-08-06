import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

import {
  flaggedColumns,
  groupIssuesByCause,
  issuesToCsvString,
  missingRequiredFields,
  normalizeColumns,
  overrideMap,
  toColumnMap,
  unmappedHeaders,
  useCsvImportCommit,
  useCsvImportPreview,
  type CsvColumnMapping,
  type CsvColumnMappingWire,
  type CsvMappingConfidence,
  type CsvTargetField,
} from './useCsvImport';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function csvFile(name = 'plan.csv'): File {
  return new File(['Title\nDig footings'], name, { type: 'text/csv' });
}

const FIELDS: CsvTargetField[] = [
  { field: 'name', label: 'Task name', required: true, multi: false },
  { field: 'duration', label: 'Duration', required: false, multi: false },
  { field: 'labels', label: 'Labels', required: false, multi: true },
];

const col = (
  index: number,
  header: string,
  field: string,
  confidence: CsvMappingConfidence = 'exact',
): CsvColumnMapping => ({ index, header, field, confidence });

/**
 * Regression coverage for #2777: the shared axios instance defaults
 * `Content-Type: application/json`, which makes axios's `transformRequest`
 * run `formDataToJSON()` on a `FormData` body and silently drop the `File` —
 * the request leaves the browser as JSON even though a `FormData` was posted.
 * Both mutations must override the header (and opt out of the client's 30s
 * default timeout, since uploads can run long) on every call, not just when
 * it happens to work.
 */
describe('useCsvImportPreview and useCsvImportCommit (#2777)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('POSTs the preview as multipart/form-data with no client-side timeout', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        filename: 'plan.csv',
        headers: ['Title'],
        columns: [],
        sample_rows: [],
        row_count: 1,
        truncated_rows: 0,
        task_count: 1,
        resource_count: 0,
        row_errors: [],
        error_count: 0,
        warning_count: 0,
        warnings: [],
        available_fields: [],
      },
    });

    const { result } = renderHook(() => useCsvImportPreview('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ file: csvFile() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body, config] = postMock.mock.calls[0] as [
      string,
      FormData,
      { headers: Record<string, string>; timeout: number },
    ];
    expect(url).toBe('/projects/p1/import/csv/preview/');
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('file')).toBeInstanceOf(File);
    expect(config).toEqual({ headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 });
  });

  it('POSTs the commit as multipart/form-data with no client-side timeout', async () => {
    postMock.mockResolvedValueOnce({
      data: { detail: 'queued', queued: true, import_request_id: 'req-1' },
    });

    const { result } = renderHook(() => useCsvImportCommit('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ file: csvFile(), columnMap: { Title: 'name' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body, config] = postMock.mock.calls[0] as [
      string,
      FormData,
      { headers: Record<string, string>; timeout: number },
    ];
    expect(url).toBe('/projects/p1/import/csv/');
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('file')).toBeInstanceOf(File);
    expect(body.get('column_map')).toBe(JSON.stringify({ Title: 'name' }));
    expect(config).toEqual({ headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 });
  });
});

describe('missingRequiredFields', () => {
  it('reports a required field no column maps to', () => {
    const missing = missingRequiredFields([col(0, 'Days', 'duration')], FIELDS);
    expect(missing.map((f) => f.field)).toEqual(['name']);
  });

  it('is satisfied once some column maps to it', () => {
    expect(missingRequiredFields([col(0, 'Title', 'name')], FIELDS)).toEqual([]);
  });

  it('treats an ignored column as unmapped, not as coverage', () => {
    // A column whose field was cleared to "Don't import" must not satisfy a
    // required field — otherwise Next unblocks and the import creates 0 tasks.
    const missing = missingRequiredFields([col(0, 'Title', '')], FIELDS);
    expect(missing.map((f) => f.field)).toEqual(['name']);
  });

  it('never reports optional fields', () => {
    const missing = missingRequiredFields([col(0, 'Title', 'name')], FIELDS);
    expect(missing).toEqual([]);
  });
});

describe('toColumnMap', () => {
  it('maps header → field and omits ignored columns', () => {
    expect(
      toColumnMap([col(0, 'Title', 'name'), col(1, 'Notes', ''), col(2, 'Days', 'duration')]),
    ).toEqual({ Title: 'name', Days: 'duration' });
  });

  it('is empty when nothing is mapped', () => {
    expect(toColumnMap([col(0, 'Title', '')])).toEqual({});
  });
});

describe('unmappedHeaders', () => {
  it('names the columns that will not be imported', () => {
    expect(unmappedHeaders([col(0, 'Title', 'name'), col(1, 'Notes', '')])).toEqual(['Notes']);
  });

  it('is empty when every column is mapped', () => {
    expect(unmappedHeaders([col(0, 'Title', 'name')])).toEqual([]);
  });
});

describe('normalizeColumns', () => {
  it('folds the wire null to an empty string', () => {
    // The server sends null for an unmatched column. Passing that straight to
    // <select value={…}> flips the control to uncontrolled, so the fold has to
    // happen at the boundary.
    const wire: CsvColumnMappingWire[] = [
      { index: 0, header: 'Notes', field: null, confidence: 'none' },
    ];
    expect(normalizeColumns(wire)).toEqual([
      { index: 0, header: 'Notes', field: '', confidence: 'none' },
    ]);
  });

  it('folds the null a duplicate column carries', () => {
    const wire: CsvColumnMappingWire[] = [
      { index: 0, header: 'Task', field: 'name', confidence: 'exact' },
      { index: 1, header: 'Title', field: null, confidence: 'duplicate' },
    ];
    const out = normalizeColumns(wire);
    expect(out[1]).toEqual({ index: 1, header: 'Title', field: '', confidence: 'duplicate' });
  });

  it('leaves a matched column untouched', () => {
    const wire: CsvColumnMappingWire[] = [
      { index: 0, header: 'Title', field: 'name', confidence: 'exact' },
    ];
    expect(normalizeColumns(wire)[0].field).toBe('name');
  });

  it('keeps normalized columns usable by toColumnMap', () => {
    const wire: CsvColumnMappingWire[] = [
      { index: 0, header: 'Title', field: 'name', confidence: 'exact' },
      { index: 1, header: 'Notes', field: null, confidence: 'none' },
    ];
    expect(toColumnMap(normalizeColumns(wire))).toEqual({ Title: 'name' });
  });
});

describe('overrideMap', () => {
  const COLS = [
    col(0, 'Title', 'name', 'exact'),
    col(1, 'Days', 'duration', 'fuzzy'),
    col(2, 'Notes', 'notes', 'override'),
  ];

  it('pins only the columns the operator touched', () => {
    // Echoing the whole mapping back would make the server mark every column
    // `override`, laundering the untouched `fuzzy` guess into "Your choice".
    expect(overrideMap(COLS, new Set([2]))).toEqual({ Notes: 'notes' });
  });

  it('sends an explicit ignore rather than omitting it', () => {
    // Omitting an ignored column lets auto-detection put it straight back.
    const cleared = [col(0, 'Title', 'name', 'exact'), col(1, 'Days', '', 'override')];
    expect(overrideMap(cleared, new Set([1]))).toEqual({ Days: '' });
  });

  it('is empty when nothing has been touched', () => {
    expect(overrideMap(COLS, new Set())).toEqual({});
  });

  it('never pins a column outside the changed set', () => {
    expect(overrideMap(COLS, new Set([0]))).toEqual({ Title: 'name' });
  });
});

describe('flaggedColumns', () => {
  it('flags exactly the guessed and dropped columns', () => {
    // These two are the operator's job on the mapping step: a fuzzy match is a
    // guess to confirm, and a duplicate is a column silently dropped.
    const flagged = flaggedColumns([
      col(0, 'Title', 'name', 'exact'),
      col(1, 'Days', 'duration', 'fuzzy'),
      col(2, 'Task', '', 'duplicate'),
      col(3, 'Notes', '', 'none'),
      col(4, 'Owner', 'assignee', 'override'),
    ]);
    expect(flagged.map((c) => c.header)).toEqual(['Days', 'Task']);
  });

  it('is empty when every column matched exactly', () => {
    expect(flaggedColumns([col(0, 'Title', 'name', 'exact')])).toEqual([]);
  });

  it('does not flag a column the operator has already overridden', () => {
    expect(flaggedColumns([col(0, 'Days', 'duration', 'override')])).toEqual([]);
  });
});

describe('groupIssuesByCause (#2732)', () => {
  it('collapses one cause into one entry, largest first', () => {
    // A 400-row sheet with one wrong date format produces 400 identical lines;
    // the grouping is what turns that back into a single edit to make.
    const groups = groupIssuesByCause([
      { row: 3, code: 'bad_date', message: "Could not read 'a'." },
      { row: 4, code: 'missing_name', message: 'Row has no task name.' },
      { row: 5, code: 'bad_date', message: "Could not read 'b'." },
      { row: 6, code: 'bad_date', message: "Could not read 'c'." },
    ]);
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([
      ['Unreadable date', 3],
      ['No task name', 1],
    ]);
    expect(groups[0].rows).toEqual([3, 5, 6]);
  });

  it('keeps one concrete example per group, since the label is a category', () => {
    const [group] = groupIssuesByCause([
      { row: 3, code: 'bad_date', message: "Could not read 'not-a-date' as a date." },
      { row: 5, code: 'bad_date', message: "Could not read 'soon' as a date." },
    ]);
    expect(group.example).toContain('not-a-date');
  });

  it('derives a readable label for a code this build has never seen', () => {
    // A new server check must not render as a raw identifier or as nothing.
    const [group] = groupIssuesByCause([{ row: 2, code: 'brand_new_check', message: 'x' }]);
    expect(group.label).toBe('Brand new check');
  });

  it('falls back to the message when the server sent no code', () => {
    // Degrades to one group per distinct text rather than folding unrelated
    // problems together on a shared `undefined` key.
    const groups = groupIssuesByCause([
      { row: 2, message: 'Duration is not a number' },
      { row: 3, message: 'Start is not a date' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe('Duration is not a number');
  });

  it('is empty for no issues', () => {
    expect(groupIssuesByCause([])).toEqual([]);
  });
});

describe('issuesToCsvString (#2732)', () => {
  it('writes one row per diagnostic under a stable header', () => {
    const csv = issuesToCsvString([
      { row: 7, column: 'Title', code: 'missing_name', severity: 'error', message: 'No name.' },
    ]);
    expect(csv.split('\r\n')).toEqual([
      'Row,Column,Severity,Cause,Message',
      '7,Title,error,missing_name,No name.',
    ]);
  });

  it('leaves the optional fields blank rather than writing "undefined"', () => {
    const csv = issuesToCsvString([{ row: 4, message: 'Bad' }]);
    expect(csv.split('\r\n')[1]).toBe('4,,,,Bad');
  });

  it('neutralizes a formula-injection payload carried in a message (#2762)', () => {
    // Import applies no character filtering, so a task name quoted back inside
    // a diagnostic reaches this file verbatim and would execute on open.
    const csv = issuesToCsvString([{ row: 2, message: '=cmd|\'/C calc\'!A0' }]);
    expect(csv).toContain("'=cmd");
    expect(csv).not.toMatch(/,=cmd/);
  });

  it('cannot be made to forge a record with an interior carriage return', () => {
    // The parser quotes the offending cell verbatim into the message, and a `\r`
    // survives `.strip()`. Records here are joined with \r\n, so an unquoted \r
    // would end the row and start the next one at `=cmd…` — past the leading
    // formula guard, which only sees position 0 of a field.
    const csv = issuesToCsvString([
      { row: 3, code: 'bad_date', message: "Could not read '2026-99-99\r=cmd|'/C calc'!A0'." },
    ]);
    expect(csv.split('\r\n')).toHaveLength(2);
    expect(csv.split('\r\n')[1]).not.toMatch(/^=cmd/);
  });
});
