import { describe, expect, it } from 'vitest';
import { previewTypeIcon, previewTypeLabel } from './previewType';

describe('previewType (#571)', () => {
  it('maps each known type to a distinct icon component and a human label', () => {
    const types = ['document', 'spreadsheet', 'presentation', 'image', 'pdf', 'folder', 'file'];
    const icons = types.map(previewTypeIcon);
    // Every known type resolves to a renderable icon component…
    expect(icons.every((c) => typeof c === 'function')).toBe(true);
    // …and the icons are distinct (the map is exhaustive, no accidental collision).
    expect(new Set(icons).size).toBe(types.length);
    expect(previewTypeLabel('spreadsheet')).toBe('Spreadsheet');
    expect(previewTypeLabel('pdf')).toBe('PDF');
  });

  it('falls back to the generic file icon/label for an unknown key', () => {
    // A future server value must never render blank.
    expect(previewTypeIcon('quantum_doc')).toBe(previewTypeIcon('file'));
    expect(previewTypeLabel('quantum_doc')).toBe('File');
    expect(previewTypeIcon('')).toBe(previewTypeIcon('file'));
  });
});
