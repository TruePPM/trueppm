/**
 * Split a string into matched / unmatched segments for search highlighting.
 *
 * Returns alternating segments so the caller can wrap matches in a <mark>
 * without dangerouslySetInnerHTML. Matching is accent-insensitive (mirrors
 * `matchesSearch`) but the returned `text` is always the original substring so
 * the rendered title is never mangled.
 */

import { normalize } from './filter';

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const q = normalize(query.trim());
  if (!q) return [{ text, match: false }];

  const haystack = normalize(text);
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let found = haystack.indexOf(q, cursor);

  // `normalize` is length-preserving (NFD diacritic stripping removes only
  // combining marks, which we also strip from the haystack), so indices map
  // 1:1 back onto the original string.
  while (found !== -1) {
    if (found > cursor) segments.push({ text: text.slice(cursor, found), match: false });
    segments.push({ text: text.slice(found, found + q.length), match: true });
    cursor = found + q.length;
    found = haystack.indexOf(q, cursor);
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
