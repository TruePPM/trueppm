import { parseDurationInput } from '../EditableCell';
import type { ParsedPasteRow } from './parsePastedText';

export type PasteField = 'name' | 'duration' | 'owner';
/** `override` is never produced by `inferColumns` — it marks a mapping a human
 *  corrected via "Map columns…" (`PasteColumnMappingDialog`), mirroring the CSV
 *  importer's confidence vocabulary (`packages/web/src/hooks/useCsvImport.ts`). */
export type PasteColumnConfidence = 'exact' | 'fuzzy' | 'none' | 'override';

export interface PasteColumnMapping {
  index: number;
  header: string | null;
  field: PasteField | null;
  confidence: PasteColumnConfidence;
}

const KEYWORDS: Record<PasteField, string[]> = {
  name: ['name', 'task', 'title', 'summary', 'activity'],
  duration: ['duration', 'days', 'estimate', 'length'],
  owner: ['owner', 'assignee', 'resource', 'who'],
};

const ALL_KEYWORDS = Object.values(KEYWORDS).flat();

function matchKeyword(header: string, keywords: string[]): PasteColumnConfidence {
  const h = header.trim().toLowerCase();
  if (!h) return 'none';
  if (keywords.includes(h)) return 'exact';
  if (keywords.some((k) => h.includes(k))) return 'fuzzy';
  return 'none';
}

/**
 * Whether the first row of a pasted block reads as a header rather than data —
 * any cell matching a known column keyword (mirrors the CSV importer's confidence
 * vocabulary, `packages/web/src/hooks/useCsvImport.ts`). A block with no
 * recognizable header is treated as all-data, mapped by shape alone.
 */
export function looksLikeHeaderRow(cells: string[]): boolean {
  return cells.some((cell) => matchKeyword(cell, ALL_KEYWORDS) !== 'none');
}

/**
 * Claim a column for the first unclaimed field its header names. Mutates `fields`,
 * `confidences` and `claimed` in place, since the two fallbacks below read what this
 * left behind. Left to right across every column, and every field is claimable at
 * most once — a second "Days" column stays unmapped rather than stealing the first.
 */
function applyHeaderMatches(
  header: string[],
  columnCount: number,
  claimed: Set<PasteField>,
  fields: (PasteField | null)[],
  confidences: PasteColumnConfidence[],
): void {
  for (let index = 0; index < columnCount; index++) {
    const headerText = header[index];
    if (!headerText) continue;
    for (const candidate of Object.keys(KEYWORDS) as PasteField[]) {
      if (claimed.has(candidate)) continue;
      const m = matchKeyword(headerText, KEYWORDS[candidate]);
      if (m !== 'none') {
        fields[index] = candidate;
        confidences[index] = m;
        claimed.add(candidate);
        break;
      }
    }
  }
}

/**
 * The leftmost unclaimed column whose sample values mostly parse as durations, or
 * null. Sampled rather than exhaustive (20 rows) and thresholded at 70%, so a stray
 * "TBD" in an otherwise numeric column does not cost the whole mapping.
 */
function findDurationColumnByShape(
  dataRows: ParsedPasteRow[],
  columnCount: number,
  fields: (PasteField | null)[],
): number | null {
  for (let index = 0; index < columnCount; index++) {
    if (fields[index] !== null) continue;
    const sample = dataRows.slice(0, 20).map((row) => row.cells[index] ?? '');
    const nonBlank = sample.filter((v) => v.trim().length > 0);
    const parseable = nonBlank.filter((v) => parseDurationInput(v) !== null);
    if (nonBlank.length > 0 && parseable.length / nonBlank.length >= 0.7) return index;
  }
  return null;
}

/**
 * Guess which column is name / duration / owner. Pure — like
 * `authoringTokens.ts`'s lexer, guessing never touches the roster; only the
 * owner *value* resolution downstream in `buildPasteOperations` does that.
 *
 * Header-keyword matches take priority; an unclaimed first column falls back to
 * `name` by convention, and an unclaimed column whose sample values mostly parse
 * as a duration falls back to `duration` by shape. Everything else is left
 * unmapped rather than guessed at — a wrong silent guess is worse than an
 * "ignored" column the receipt strip surfaces and "Map columns…" can fix.
 */
export function inferColumns(rows: ParsedPasteRow[], hasHeaderRow: boolean): PasteColumnMapping[] {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const header = hasHeaderRow ? (rows[0]?.cells ?? []) : [];
  const dataRows = hasHeaderRow ? rows.slice(1) : rows;
  const claimed = new Set<PasteField>();
  const fields: (PasteField | null)[] = new Array<PasteField | null>(columnCount).fill(null);
  const confidences: PasteColumnConfidence[] = new Array<PasteColumnConfidence>(columnCount).fill(
    'none',
  );

  // Pass 1 — header keywords across every column, left to right. Run to
  // completion BEFORE any fallback: a header match on column 2 must win over
  // column 0's "first column is the name" convention, which only applies once
  // every header has had its chance.
  applyHeaderMatches(header, columnCount, claimed, fields, confidences);

  // Pass 2 — shape fallbacks, only for what no header claimed.
  if (!claimed.has('name') && columnCount > 0 && fields[0] === null) {
    fields[0] = 'name';
    confidences[0] = 'fuzzy';
    claimed.add('name');
  }
  if (!claimed.has('duration')) {
    // After the name fallback, so a first column it just claimed is no longer a
    // candidate for duration.
    const index = findDurationColumnByShape(dataRows, columnCount, fields);
    if (index !== null) {
      fields[index] = 'duration';
      confidences[index] = 'fuzzy';
    }
  }

  return Array.from({ length: columnCount }, (_, index) => ({
    index,
    header: header[index] ?? null,
    field: fields[index],
    confidence: fields[index] ? confidences[index] : 'none',
  }));
}
