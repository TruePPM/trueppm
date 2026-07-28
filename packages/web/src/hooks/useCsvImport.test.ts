import { describe, expect, it } from 'vitest';
import {
  flaggedColumns,
  missingRequiredFields,
  normalizeColumns,
  overrideMap,
  toColumnMap,
  unmappedHeaders,
  type CsvColumnMapping,
  type CsvColumnMappingWire,
  type CsvMappingConfidence,
  type CsvTargetField,
} from './useCsvImport';

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
