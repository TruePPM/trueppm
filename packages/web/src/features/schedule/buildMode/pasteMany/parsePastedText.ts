import { inferDepths, splitIndent } from './pasteHierarchy';

/** One pasted row: its inferred outline depth and its tab-split cell values. */
export interface ParsedPasteRow {
  depth: number;
  cells: string[];
}

/**
 * Parse raw clipboard text into rows with inferred hierarchy depth and columns.
 *
 * Blank lines are dropped — a spreadsheet copy commonly carries a trailing
 * newline, and a stray blank row inside the block has nothing to author. Columns
 * split on tab, matching how every major spreadsheet app (Excel, Sheets, Numbers)
 * serializes a multi-cell copy to the clipboard as text/plain.
 */
export function parsePastedText(text: string): ParsedPasteRow[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const depths = inferDepths(lines);
  return lines.map((line, i) => {
    const { rest } = splitIndent(line);
    const cells = rest.split('\t').map((cell) => cell.trim());
    return { depth: depths[i] ?? 0, cells };
  });
}

/** Whether clipboard text looks like a multi-row paste worth intercepting. */
export function isMultiRowPaste(text: string): boolean {
  return parsePastedText(text).length > 1;
}
