import { describe, expect, it } from 'vitest';
import {
  missingRequiredFields,
  toColumnMap,
  unmappedHeaders,
  type CsvColumnMapping,
  type CsvTargetField,
} from './useCsvImport';

const FIELDS: CsvTargetField[] = [
  { field: 'name', label: 'Task name', required: true, multi: false },
  { field: 'duration', label: 'Duration', required: false, multi: false },
  { field: 'labels', label: 'Labels', required: false, multi: true },
];

const col = (index: number, header: string, field: string): CsvColumnMapping => ({
  index,
  header,
  field,
  confidence: 1,
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
