import { describe, it, expect } from 'vitest';
import { isMultiRowPaste, parsePastedText } from './parsePastedText';

describe('parsePastedText', () => {
  it('splits multi-column rows on tab and reads depth from indentation', () => {
    const text = 'Phase 1\t\tPM\n\tDesign\t3d\tAna\n\t\tWireframes\t2d\tAna';
    expect(parsePastedText(text)).toEqual([
      { depth: 0, cells: ['Phase 1', '', 'PM'] },
      { depth: 1, cells: ['Design', '3d', 'Ana'] },
      { depth: 2, cells: ['Wireframes', '2d', 'Ana'] },
    ]);
  });

  it('drops blank lines', () => {
    const text = 'Root\n\n  Child\n\n';
    expect(parsePastedText(text)).toEqual([
      { depth: 0, cells: ['Root'] },
      { depth: 1, cells: ['Child'] },
    ]);
  });

  it('normalizes CRLF and lone CR line endings', () => {
    expect(parsePastedText('Root\r\n  Child\r  Sibling')).toEqual([
      { depth: 0, cells: ['Root'] },
      { depth: 1, cells: ['Child'] },
      { depth: 1, cells: ['Sibling'] },
    ]);
  });

  it('a single-column paste is one cell per row', () => {
    expect(parsePastedText('Root\n  Child')).toEqual([
      { depth: 0, cells: ['Root'] },
      { depth: 1, cells: ['Child'] },
    ]);
  });

  it('empty text yields no rows', () => {
    expect(parsePastedText('')).toEqual([]);
    expect(parsePastedText('   \n  \n')).toEqual([]);
  });
});

describe('isMultiRowPaste', () => {
  it('is false for a single row or blank text', () => {
    expect(isMultiRowPaste('Just one task')).toBe(false);
    expect(isMultiRowPaste('')).toBe(false);
    expect(isMultiRowPaste('  \n  ')).toBe(false);
  });

  it('is true for two or more rows', () => {
    expect(isMultiRowPaste('Task A\nTask B')).toBe(true);
  });
});
