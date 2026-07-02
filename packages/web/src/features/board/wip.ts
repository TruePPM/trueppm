/**
 * Shared WIP-limit banding (#232, #546).
 *
 * Every WIP-limit surface — board column headers/badges, the sprint-panel
 * header chip, future swimlane/column counters — must read the SAME three-band
 * model so a given `count/limit` state looks identical everywhere it appears:
 *
 *   count <  limit  → 'under' (neutral, no warning chrome)
 *   count == limit  → 'at'    (at-risk amber)
 *   count >  limit  → 'over'  (critical red)
 *   limit == null   → 'none'  (no limit configured)
 *
 * Reuse `wipState()` rather than a local `count > limit` check so the bands
 * never drift between surfaces.
 */
export type WipState = 'under' | 'at' | 'over' | 'none';

/** Returns the WIP-state band for a count against an optional limit. */
export function wipState(count: number, limit: number | null | undefined): WipState {
  if (limit == null) return 'none';
  if (count > limit) return 'over';
  if (count >= limit) return 'at';
  return 'under';
}

/** Recent direction of a column's occupancy relative to its WIP limit (issue 1213). */
export type WipTrendDirection = 'rising' | 'falling';

export interface WipTrend {
  /** Whether the column's recent occupancy is going up or down. */
  direction: WipTrendDirection;
  /**
   * True only when the column is *rising* AND sits within one card of (or past)
   * its limit — the actionable "creep about to breach" case that earns amber. A
   * rising column comfortably under its limit is informational, not at-risk.
   */
  approaching: boolean;
}

/**
 * Computes the recent trend of a column's occupancy toward its WIP limit from a
 * CFD daily-count series, so a board can flag creep *before* the breach (issue 1213).
 *
 * `series` is the per-day count of items in the column's status, oldest→newest,
 * as carried by the flow-metrics CFD (`cfd[].counts.<STATUS>`, ADR-0130 D1). The
 * latest value is compared against the value `lookback` days earlier (default 3)
 * — a short recent window so a breach building *this* sprint surfaces without a
 * whole-window lag damping it out.
 *
 * Returns `null` when a trend arrow would be noise or meaningless:
 *   - no WIP limit configured (a trend *toward a limit* needs a limit),
 *   - fewer than two data points (can't compute a direction),
 *   - a flat slope (rendering an arrow for "no change" adds chrome, not signal).
 *
 * This is intentionally a pure function with no CFD-shape or suppression
 * knowledge: the caller passes `[]` (→ null) when metrics are suppressed
 * (ADR-0104) or when the status has no CFD series (e.g. ON_HOLD).
 */
export function wipTrend(
  series: number[],
  limit: number | null | undefined,
  lookback = 3,
): WipTrend | null {
  if (limit == null) return null;
  if (series.length < 2) return null;
  const latest = series[series.length - 1];
  const prior = series[Math.max(0, series.length - 1 - lookback)];
  if (latest === prior) return null;
  const direction: WipTrendDirection = latest > prior ? 'rising' : 'falling';
  const approaching = direction === 'rising' && latest + 1 >= limit;
  return { direction, approaching };
}
