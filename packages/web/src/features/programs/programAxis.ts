/**
 * The one shared date axis every program-overview row draws its P50–P80 band on
 * (#4799), so rows compare at a glance. Pure layout: it maps server dates to a
 * percentage of the track and computes no metric.
 *
 * The domain spans every row's P50, P80 and commitment, padded a little, but never
 * wider than `maxSpanDays` from its start: one project forecast years out would
 * otherwise squash every other band to a sliver. When the rows span more than that, the window is the one holding the most dates, so
 * one outlier (early or late) is clamped rather than squashing every other row. A date
 * past either end is clamped to that edge and flagged, so the row can draw a visible edge marker instead of
 * clipping the band silently.
 */

export interface AxisInput {
  p50: string | null;
  p80: string | null;
  commitment_date: string | null;
}

export interface Axis {
  /** Epoch days (UTC) of the axis start and end. */
  start: number;
  end: number;
}

export interface AxisPosition {
  /** 0–100, already clamped. */
  pct: number;
  /** Which edge the date was clamped to, or null when it is on the axis. */
  clamped: 'start' | 'end' | null;
}

const DAY_MS = 86_400_000;
export const DEFAULT_MAX_SPAN_DAYS = 365;

/** ISO date (YYYY-MM-DD) to whole UTC days since the epoch. */
export function epochDay(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

/** The shared axis, or null when no row has a date to place. */
export function buildAxis(
  rows: AxisInput[],
  maxSpanDays: number = DEFAULT_MAX_SPAN_DAYS,
): Axis | null {
  const days = rows
    .flatMap((r) => [r.p50, r.p80, r.commitment_date])
    .filter((d): d is string => typeof d === 'string')
    .map(epochDay)
    .filter((d) => Number.isFinite(d));
  if (days.length === 0) return null;
  const min = Math.min(...days);
  const max = Math.max(...days);
  // Capped: the pad scales with the window that is drawn, not with an outlier's distance.
  const pad = Math.max(3, Math.round(Math.min(max - min, maxSpanDays) * 0.05));
  let start = min - pad;
  if (max - min + 2 * pad > maxSpanDays) {
    // Too wide to show whole: anchor on the window that holds the most dates, not
    // on the earliest one, so a single early outlier is the row that is clamped
    // (start edge) rather than every other row clamping at the end.
    const sorted = [...days].sort((a, b) => a - b);
    const usable = maxSpanDays - 2 * pad;
    let best = sorted[0];
    let bestCount = 0;
    for (const s of sorted) {
      const count = sorted.filter((d) => d >= s && d <= s + usable).length;
      if (count > bestCount) {
        best = s;
        bestCount = count;
      }
    }
    start = best - pad;
  }
  const end = Math.min(max + pad, start + maxSpanDays);
  // A single date still needs a visible width.
  return { start, end: end > start ? end : start + 2 * pad };
}

/** Where a date sits on the axis, clamped to the track with the edge it hit. */
export function axisPosition(axis: Axis, iso: string): AxisPosition {
  const day = epochDay(iso);
  if (day < axis.start) return { pct: 0, clamped: 'start' };
  if (day > axis.end) return { pct: 100, clamped: 'end' };
  return { pct: ((day - axis.start) / (axis.end - axis.start)) * 100, clamped: null };
}
