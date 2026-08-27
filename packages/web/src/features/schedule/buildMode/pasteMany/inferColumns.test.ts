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
  // #3102 — allocation column. Before this, `PasteField` had no `units` member, so a
  // spreadsheet's allocation column was unmappable and every owner landed at 100%.
  it('maps an Allocation header to units at exact confidence', () => {
    const data = rows([
      ['Name', 'Owner', 'Allocation'],
      ['Survey', 'Ana', '50%'],
    ]);
    const mapping = inferColumns(data, true);
    expect(mapping[2]).toEqual({
      index: 2,
      header: 'Allocation',
      field: 'units',
      confidence: 'exact',
    });
  });

  it('maps a fuzzy allocation header (Allocation %) to units', () => {
    const data = rows([
      ['Name', 'Allocation %'],
      ['Survey', '50%'],
    ]);
    expect(inferColumns(data, true)[1].field).toBe('units');
  });

  it('no header row: a percent-suffixed column is guessed as units by shape', () => {
    const data = rows([
      ['Survey', '50%'],
      ['Design', '75 %'],
      ['Build', '100%'],
    ]);
    const mapping = inferColumns(data, false);
    expect(mapping[1]).toEqual({ index: 1, header: null, field: 'units', confidence: 'fuzzy' });
  });

  it('does NOT claim a bare-number column as units — duration owns that shape', () => {
    // The whole reason the shape test requires a trailing `%`: `50` is a legal
    // duration and guessing allocation would silently retype an existing paste.
    const data = rows([
      ['Survey', '50'],
      ['Design', '75'],
    ]);
    expect(inferColumns(data, false)[1].field).toBe('duration');
  });

  it('a percent column does not contend with a duration column', () => {
    const data = rows([
      ['Survey', '5d', '50%'],
      ['Design', '3d', '75%'],
    ]);
    const mapping = inferColumns(data, false);
    expect(mapping[1].field).toBe('duration');
    expect(mapping[2].field).toBe('units');
  });

  it('an owner-matching header still wins over units — "Map columns…" is the repair', () => {
    // "Resource Allocation" has read as the owner column since paste-many shipped;
    // repointing it would change what an existing paste commits.
    const data = rows([
      ['Name', 'Resource Allocation'],
      ['Survey', 'Ana'],
    ]);
    expect(inferColumns(data, true)[1].field).toBe('owner');
  });
});
