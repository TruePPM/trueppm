import { describe, expect, it } from 'vitest';
import { highlightSegments } from './highlight';

describe('highlightSegments', () => {
  it('returns a single unmatched segment for an empty query', () => {
    expect(highlightSegments('Telemetry', '')).toEqual([{ text: 'Telemetry', match: false }]);
  });

  it('wraps the matched substring, preserving original casing', () => {
    expect(highlightSegments('Telemetry link', 'tele')).toEqual([
      { text: 'Tele', match: true },
      { text: 'metry link', match: false },
    ]);
  });

  it('matches accent-insensitively but keeps the original glyphs', () => {
    expect(highlightSegments('Pólaris', 'polaris')).toEqual([{ text: 'Pólaris', match: true }]);
  });

  it('highlights every occurrence', () => {
    const segments = highlightSegments('aXaXa', 'a');
    expect(segments.filter((s) => s.match)).toHaveLength(3);
    expect(segments.map((s) => s.text).join('')).toBe('aXaXa');
  });
});
