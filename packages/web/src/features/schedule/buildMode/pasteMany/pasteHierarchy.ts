/**
 * Leading-indentation → depth inference for paste-many (#2724).
 *
 * Two indentation sources exist in the wild and are structurally different:
 *
 * - A plain indented outline (copied from a text editor / another outliner) uses
 *   leading TAB characters purely for depth — each one is unambiguous.
 * - A spreadsheet cell that a user manually indented ("  Subtask") uses leading
 *   SPACES, and the space-per-level count is whatever that author happened to type
 *   — never announced, so it has to be inferred from the block itself.
 *
 * This module is deliberately pure — no React, no store, no roster — so depth
 * inference is unit-testable in isolation from column guessing and row building.
 */

/** A raw pasted line split into its leading whitespace and the rest. */
export interface SplitIndent {
  indent: string;
  rest: string;
}

/** Split a line into its leading run of spaces/tabs and everything after it. */
export function splitIndent(line: string): SplitIndent {
  const m = /^([ \t]*)(.*)$/.exec(line);
  if (!m) return { indent: '', rest: line };
  return { indent: m[1] ?? '', rest: m[2] ?? '' };
}

/**
 * The space-run length that represents one indent level, inferred from the block.
 *
 * Only rows with NO leading tabs are counted — mixing a tab-indented row into the
 * sample would conflate a tab (always exactly one level) with a author's chosen
 * space width. Defaults to 2 when the block carries no space-only signal (a
 * pure-tab block, or a flat block with no indentation at all).
 */
export function detectSpaceUnit(indents: string[]): number {
  const counts = indents
    .filter((i) => !i.includes('\t'))
    .map((i) => i.length)
    .filter((n) => n > 0);
  return counts.length > 0 ? Math.min(...counts) : 2;
}

/** Raw, unclamped indent score for one line: tabs count 1 each, plus whole space units. */
function rawIndentScore(indent: string, spaceUnit: number): number {
  let tabs = 0;
  let spaces = 0;
  for (const ch of indent) {
    if (ch === '\t') tabs += 1;
    else spaces += 1;
  }
  return tabs + Math.floor(spaces / spaceUnit);
}

/**
 * Infer a 0-based depth per line from leading indentation — tabs, spaces, a mix of
 * both across the block, and RAGGED indentation (a line's raw indent score jumps by
 * more than one level from its predecessor, e.g. a copy-paste artifact or an author
 * who skipped a level). A depth can never exceed the previous line's depth + 1: an
 * outline has no way to be more than one level deeper than the row above it, so a
 * jump is clamped rather than trusted verbatim — the standard ragged-indent
 * normalization rule.
 */
export function inferDepths(lines: string[]): number[] {
  const indents = lines.map((line) => splitIndent(line).indent);
  const spaceUnit = detectSpaceUnit(indents);
  const depths: number[] = [];
  let previous = 0;
  for (const indent of indents) {
    const raw = rawIndentScore(indent, spaceUnit);
    const depth = Math.max(0, Math.min(raw, previous + 1));
    depths.push(depth);
    previous = depth;
  }
  return depths;
}
