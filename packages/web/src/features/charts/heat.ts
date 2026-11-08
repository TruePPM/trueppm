/**
 * Heat palette mapping: a server-supplied load percentage -> a palette step.
 * This bins a value for display; it never derives one (ADR-1314: load_pct is the
 * server's).
 */
export type HeatCell =
  | { kind: 'none' }
  | { kind: 'step'; n: 1 | 2 | 3 | 4 | 5 }
  | { kind: 'over'; n: 1 | 2 };

/** Inclusive upper bound of the over-1 band; matches the --p1-over-1 token comment (101-115%). */
export const OVER_1_MAX_PCT = 115;

/**
 * 0 -> none; (0,100] -> five equal 20-point steps; 101-115 -> over-1; >115 -> over-2.
 * Non-finite or negative input is `none` rather than a color that asserts a load.
 */
export function heatCell(loadPct: number | null | undefined): HeatCell {
  if (loadPct == null || !Number.isFinite(loadPct) || loadPct <= 0) return { kind: 'none' };
  if (loadPct > OVER_1_MAX_PCT) return { kind: 'over', n: 2 };
  if (loadPct > 100) return { kind: 'over', n: 1 };
  const n = Math.min(5, Math.max(1, Math.ceil(loadPct / 20))) as 1 | 2 | 3 | 4 | 5;
  return { kind: 'step', n };
}

/** CSS color for a cell (uses the --p1-* tokens, so both themes work). */
export function heatFill(cell: HeatCell): string {
  switch (cell.kind) {
    case 'none':
      return 'oklch(var(--p1-surface-2))';
    case 'step':
      return `oklch(var(--p1-heat-${cell.n}))`;
    case 'over':
      return `oklch(var(--p1-over-${cell.n}))`;
  }
}

/** Ink token that clears 4.5:1 on the cell's fill (pinned by p1Tokens.test.ts). */
export function heatInk(cell: HeatCell): string {
  switch (cell.kind) {
    case 'none':
      return 'oklch(var(--p1-text-2))';
    case 'step':
      return cell.n >= 4 ? 'oklch(var(--p1-on-brand))' : 'oklch(var(--p1-text-1))';
    case 'over':
      return 'oklch(var(--p1-on-over))';
  }
}

/** Plain-English band name; the non-color half of the encoding. */
export function heatLabel(cell: HeatCell): string {
  switch (cell.kind) {
    case 'none':
      return 'No load';
    case 'step':
      return `${(cell.n - 1) * 20 + 1}–${cell.n * 20}% load`;
    case 'over':
      return cell.n === 1 ? '101–115% load (over-allocated)' : 'Over 115% load (over-allocated)';
  }
}
