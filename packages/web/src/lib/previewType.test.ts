import { describe, expect, it } from 'vitest';
import { previewTypeGlyph, previewTypeLabel } from './previewType';

describe('previewType (#571)', () => {
  it('maps each known type to a distinct glyph and a human label', () => {
    const types = ['document', 'spreadsheet', 'presentation', 'image', 'pdf', 'folder', 'file'];
    const glyphs = types.map(previewTypeGlyph);
    // Every known type resolves to a non-empty glyph…
    expect(glyphs.every((g) => g.length > 0)).toBe(true);
    // …and the glyphs are distinct (the map is exhaustive, no accidental collision).
    expect(new Set(glyphs).size).toBe(types.length);
    expect(previewTypeLabel('spreadsheet')).toBe('Spreadsheet');
    expect(previewTypeLabel('pdf')).toBe('PDF');
  });

  it('falls back to the generic file glyph/label for an unknown key', () => {
    // A future server value must never render blank.
    expect(previewTypeGlyph('quantum_doc')).toBe(previewTypeGlyph('file'));
    expect(previewTypeLabel('quantum_doc')).toBe('File');
    expect(previewTypeGlyph('')).toBe(previewTypeGlyph('file'));
  });
});
