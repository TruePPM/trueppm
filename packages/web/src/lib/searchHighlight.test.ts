import { describe, expect, it } from 'vitest';
import { highlightSegments, normalizeForSearch, prefixSegments } from './searchHighlight';

/** Concatenating the segments must always reproduce the input exactly. */
function rejoin(segments: { text: string }[]): string {
  return segments.map((s) => s.text).join('');
}

describe('normalizeForSearch', () => {
  it('is length-preserving, which is what lets indices map back', () => {
    // The whole segmentation relies on this: `indexOf` runs on the normalized
    // haystack and slices the ORIGINAL string at the returned index.
    for (const value of ['Pólaris', 'Café', 'ÀÉÎÕÜ', 'plain']) {
      expect(normalizeForSearch(value)).toHaveLength(value.length);
    }
  });

  it('folds case and diacritics', () => {
    expect(normalizeForSearch('Pólaris')).toBe('polaris');
  });
});

describe('highlightSegments — substring anchoring', () => {
  it('marks every occurrence, in order', () => {
    expect(highlightSegments('ban banana', 'ban')).toEqual([
      { text: 'ban', match: true },
      { text: ' ', match: false },
      { text: 'ban', match: true },
      { text: 'ana', match: false },
    ]);
  });

  it('returns the ORIGINAL casing, not the query', () => {
    expect(highlightSegments('Lay-down area survey', 'lay')).toEqual([
      { text: 'Lay', match: true },
      { text: '-down area survey', match: false },
    ]);
  });

  it('matches through diacritics without mangling the text', () => {
    const segments = highlightSegments('Pólaris review', 'polaris');
    expect(segments[0]).toEqual({ text: 'Pólaris', match: true });
    expect(rejoin(segments)).toBe('Pólaris review');
  });

  it('marks nothing for an empty query', () => {
    expect(highlightSegments('anything', '   ')).toEqual([{ text: 'anything', match: false }]);
  });

  it('marks nothing when the query is absent', () => {
    expect(highlightSegments('anything', 'zzz')).toEqual([{ text: 'anything', match: false }]);
  });
});

describe('prefixSegments — leading anchoring', () => {
  it('marks the leading run only', () => {
    expect(prefixSegments('1.1', '1.')).toEqual([
      { text: '1.', match: true },
      { text: '1', match: false },
    ]);
  });

  it('marks NOTHING when the occurrence is not at the start', () => {
    // This is the whole reason it is not `highlightSegments`. `11.1` contains
    // `1.` at index 1, and the picker's filter (`startsWith`) rejected the row —
    // so marking it would claim a reason the filter did not use.
    expect(prefixSegments('11.1', '1.')).toEqual([{ text: '11.1', match: false }]);
  });

  it('does not mark a second occurrence further along', () => {
    expect(prefixSegments('1.1.', '1.')).toEqual([
      { text: '1.', match: true },
      { text: '1.', match: false },
    ]);
  });

  it('marks the whole string when the query consumes it', () => {
    expect(prefixSegments('1.1', '1.1')).toEqual([{ text: '1.1', match: true }]);
  });

  it('marks nothing for an empty query', () => {
    expect(prefixSegments('1.1', '')).toEqual([{ text: '1.1', match: false }]);
  });
});
