import { describe, it, expect } from 'vitest';
import type { ParsedPasteRow } from './parsePastedText';
import { inferColumns, looksLikeHeaderRow } from './inferColumns';

function rows(cells: string[][]): ParsedPasteRow[] {
  return cells.map((c) => ({ depth: 0, cells: c }));
}

describe('looksLikeHeaderRow', () => {
  it('is true when a cell matches a known column keyword', () => {
    expect(looksLikeHeaderRow(['Task', 'Duration', 'Owner'])).toBe(true);
    expect(looksLikeHeaderRow(['Name', 'Days'])).toBe(true);
  });

  it('is false for a plain data row', () => {
    expect(looksLikeHeaderRow(['Survey', '5', 'Ana'])).toBe(false);
  });
});

describe('inferColumns', () => {
  it('maps by exact header keyword', () => {
    const data = rows([
      ['Task', 'Duration', 'Owner'],
      ['Survey', '5', 'Ana'],
    ]);
    const mapping = inferColumns(data, true);
    expect(mapping).toEqual([
      { index: 0, header: 'Task', field: 'name', confidence: 'exact' },
      { index: 1, header: 'Duration', field: 'duration', confidence: 'exact' },
      { index: 2, header: 'Owner', field: 'owner', confidence: 'exact' },
    ]);
  });

  it('maps by fuzzy header keyword (substring match)', () => {
    const data = rows([
      ['Task Name', 'Est. Days', 'Resource Name'],
      ['Survey', '5', 'Ana'],
    ]);
    const mapping = inferColumns(data, true);
    expect(mapping.map((m) => m.field)).toEqual(['name', 'duration', 'owner']);
    expect(mapping.every((m) => m.confidence === 'fuzzy')).toBe(true);
  });

  it('an unrecognized header column is left unmapped, not guessed', () => {
    const data = rows([
      ['Task', 'Notes', 'Owner'],
      ['Survey', 'some free text', 'Ana'],
    ]);
    const mapping = inferColumns(data, true);
    expect(mapping[1]).toEqual({ index: 1, header: 'Notes', field: null, confidence: 'none' });
  });

  it('no header row: first column falls back to name by convention', () => {
    const data = rows([
      ['Survey', 'Ana'],
      ['Design', 'Ben'],
    ]);
    const mapping = inferColumns(data, false);
    expect(mapping[0]).toEqual({ index: 0, header: null, field: 'name', confidence: 'fuzzy' });
    // Column 1 has no header and its values don't parse as durations, so it's
    // left unmapped rather than guessed as an owner column by shape alone.
    expect(mapping[1].field).toBeNull();
  });

  it('no header row: a mostly-numeric column is guessed as duration by shape', () => {
    const data = rows([
      ['Survey', '5'],
      ['Design', '3d'],
      ['Build', '2w'],
    ]);
    const mapping = inferColumns(data, false);
    expect(mapping[1]).toEqual({ index: 1, header: null, field: 'duration', confidence: 'fuzzy' });
  });

  it('does not double-claim a field across two columns', () => {
    const data = rows([
      ['Name', 'Task Title'],
      ['Survey', 'duplicate'],
    ]);
    const mapping = inferColumns(data, true);
    expect(mapping[0].field).toBe('name');
    expect(mapping[1].field).toBeNull();
  });
});
