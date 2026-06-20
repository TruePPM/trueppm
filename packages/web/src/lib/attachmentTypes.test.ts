import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_TYPE_CATALOG,
  ATTACHMENT_TYPE_GROUPS,
  DENIED_ATTACHMENT_TYPES,
  labelForMime,
  labelsForMimes,
} from './attachmentTypes';

describe('attachmentTypes catalog', () => {
  it('has unique MIME entries', () => {
    const mimes = ATTACHMENT_TYPE_CATALOG.map((o) => o.mime);
    expect(new Set(mimes).size).toBe(mimes.length);
  });

  it('derives group order from the catalog, preserving first-seen order', () => {
    expect(ATTACHMENT_TYPE_GROUPS).toEqual([
      'Documents',
      'Images',
      'Spreadsheets',
      'Presentations',
      'Archives',
    ]);
  });

  it('lists the three permanent security-denied types', () => {
    expect(DENIED_ATTACHMENT_TYPES.map((d) => d.mime)).toEqual([
      'text/html',
      'image/svg+xml',
      'application/xhtml+xml',
    ]);
  });

  it('never includes a denied type in the selectable catalog', () => {
    const catalogMimes = new Set(ATTACHMENT_TYPE_CATALOG.map((o) => o.mime));
    for (const denied of DENIED_ATTACHMENT_TYPES) {
      expect(catalogMimes.has(denied.mime)).toBe(false);
    }
  });
});

describe('labelForMime', () => {
  it('returns the human label for a catalog MIME', () => {
    expect(labelForMime('application/pdf')).toBe('PDF');
    expect(
      labelForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('Word document');
  });

  it('returns the human label for a denied MIME', () => {
    expect(labelForMime('image/svg+xml')).toBe('SVG image');
  });

  it('falls back to the raw MIME when not in the catalog', () => {
    expect(labelForMime('application/x-unknown')).toBe('application/x-unknown');
  });
});

describe('labelsForMimes', () => {
  it('maps a list to human labels, falling back per item', () => {
    expect(labelsForMimes(['application/pdf', 'application/x-weird'])).toEqual([
      'PDF',
      'application/x-weird',
    ]);
  });
});
