/**
 * Split a string into matched / unmatched segments so a caller can mark **why**
 * a row matched, without `dangerouslySetInnerHTML`.
 *
 * Two anchorings, because two surfaces mean different things by "match":
 *  - {@link highlightSegments} — every occurrence of the query as a **substring**
 *    (backlog titles, task names).
 *  - {@link prefixSegments} — the query as a **prefix** only (a WBS code, where
 *    `1.` means "phase 1" and a `1.` sitting inside `11.1` is not a hit).
 *
 * Matching is accent- and case-insensitive via {@link normalizeForSearch}, but
 * the returned `text` is always the original substring so the rendered string is
 * never mangled.
 */

/** Case- and accent-insensitive comparison form. Length-preserving. */
export function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** Every occurrence of `query` inside `text`, in order. */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const q = normalizeForSearch(query.trim());
  if (!q) return [{ text, match: false }];

  const haystack = normalizeForSearch(text);
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let found = haystack.indexOf(q, cursor);

  // `normalizeForSearch` is length-preserving (NFD diacritic stripping removes
  // only combining marks, which we also strip from the haystack), so indices map
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

/**
 * `query` as a **leading** match only — nothing is marked when `text` does not
 * start with it, and a second occurrence further along is left alone.
 *
 * That anchoring is the point rather than an optimization: the surface using it
 * (the dependency picker's WBS column) *filters* with `startsWith`, so marking a
 * mid-string occurrence would claim a reason the filter did not use.
 */
export function prefixSegments(text: string, query: string): HighlightSegment[] {
  const q = normalizeForSearch(query.trim());
  if (!q) return [{ text, match: false }];
  if (!normalizeForSearch(text).startsWith(q)) return [{ text, match: false }];

  const head = text.slice(0, q.length);
  const tail = text.slice(q.length);
  return tail ? [{ text: head, match: true }, { text: tail, match: false }] : [{ text: head, match: true }];
}
