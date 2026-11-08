/**
 * Generic chart-label row packing (web rule 413).
 *
 * A label that collides with its neighbor moves to a new ROW; the marker it
 * names never moves. This is greedy interval packing over any number of labels,
 * not a special case for one named pair.
 */

export interface PackLabel {
  key: string;
  /** The marker's true x. Never altered by packing. */
  x: number;
  text: string;
}

/**
 * Label width estimate. SVG <text> has no cheap synchronous measurement, so this
 * errs wide (a spurious extra row is the safe failure; a collision is not).
 * 7px/char suits the 12px medium sans-serif the charts use.
 */
export function estimateLabelWidth(text: string): number {
  return text.length * 7 + 4;
}

/**
 * Assigns each label the first row whose last occupant ends at least `gap` px
 * before this label begins. Labels are centered on `x`. Returns key -> row index
 * (0-based); ties on x keep input order so the result is deterministic.
 */
export function assignLabelRows(labels: readonly PackLabel[], gap = 4): Map<string, number> {
  const sorted = labels
    .map((l, i) => ({ l, i }))
    .sort((a, b) => a.l.x - b.l.x || a.i - b.i)
    .map(({ l }) => l);
  const rowRightEdge: number[] = [];
  const rowOf = new Map<string, number>();
  for (const label of sorted) {
    const half = estimateLabelWidth(label.text) / 2;
    const left = label.x - half;
    let row = rowRightEdge.findIndex((edge) => left >= edge + gap);
    if (row === -1) {
      row = rowRightEdge.length;
      rowRightEdge.push(label.x + half);
    } else {
      rowRightEdge[row] = label.x + half;
    }
    rowOf.set(label.key, row);
  }
  return rowOf;
}

/** Number of rows a packing used (at least 1, so an empty set still reserves one). */
export function rowCount(rows: ReadonlyMap<string, number>): number {
  let max = 0;
  for (const r of rows.values()) max = Math.max(max, r);
  return max + 1;
}
