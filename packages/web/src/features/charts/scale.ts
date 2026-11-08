/**
 * Pure scale + tick helpers for the shared chart layer. No DOM, no React: every
 * chart lays out through these so the geometry is unit-testable.
 */

export interface LinearScale {
  (v: number): number;
  domain: readonly [number, number];
  range: readonly [number, number];
}

/**
 * Maps `domain` onto `range`, clamping nothing. A degenerate domain (min === max)
 * maps to the range midpoint so a single-point series still draws.
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const fn = (v: number): number => {
    if (d1 === d0) return (r0 + r1) / 2;
    return r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
  };
  return Object.assign(fn, { domain, range });
}

/** Parses an ISO date or datetime to epoch milliseconds; NaN when unparseable. */
export function parseDate(iso: string): number {
  return Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
}

const DAY_MS = 86_400_000;

/**
 * Evenly spaced tick positions across a [min, max] epoch-ms domain, snapped to
 * whole UTC days so labels never read as a time of day.
 */
export function timeTicks(min: number, max: number, count: number): number[] {
  if (count < 2 || max <= min) return [min];
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = min + ((max - min) * i) / (count - 1);
    out.push(Math.round(raw / DAY_MS) * DAY_MS);
  }
  return out;
}

/** "Jun 5" in UTC, so a date-only server value never shifts a day with the viewer's zone. */
export function formatTick(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * "Nice" numeric ticks (1/2/5 × 10^n) from min up to the first tick at or above max.
 */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (max <= min || count < 1) return [min];
  const rough = (max - min) / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
  const out: number[] = [];
  const top = Math.ceil(max / step - 1e-9) * step;
  for (let v = Math.ceil(min / step) * step; v <= top + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}
