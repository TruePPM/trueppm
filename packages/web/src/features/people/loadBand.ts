import type { HeatCell } from '@/features/charts/heat';

/**
 * The six display bands of the Pass 1 load heat map (`P1.heat`), plus `none` for a
 * week the server could not compute. Bins a server-supplied `load_pct`; it never
 * derives one (ADR-1314: the figure is `GET /me/people-load/`'s).
 */
export type LoadBand = 'none' | 'lt40' | '40-59' | '60-79' | '80-100' | '101-115' | 'gt115';

/** Legend order, left to right. `none` is not a legend entry: it is a dash in the cell. */
export const LOAD_BANDS: ReadonlyArray<Exclude<LoadBand, 'none'>> = [
  'lt40',
  '40-59',
  '60-79',
  '80-100',
  '101-115',
  'gt115',
];

/** The legend text for each band, as the design writes it. */
export const LOAD_BAND_LABEL: Record<Exclude<LoadBand, 'none'>, string> = {
  lt40: '<40',
  '40-59': '40–59',
  '60-79': '60–79',
  '80-100': '80–100',
  '101-115': '101–115',
  gt115: '>115',
};

/**
 * Bin a whole-number load percentage. Bounds are inclusive on the upper side, so
 * 100 is the last full band and 101 is the first over-allocated one — the same
 * `> 100` the server uses for `overallocated`.
 */
export function loadBand(loadPct: number | null | undefined): LoadBand {
  if (loadPct == null || !Number.isFinite(loadPct) || loadPct < 0) return 'none';
  if (loadPct > 115) return 'gt115';
  if (loadPct > 100) return '101-115';
  if (loadPct >= 80) return '80-100';
  if (loadPct >= 60) return '60-79';
  if (loadPct >= 40) return '40-59';
  return 'lt40';
}

/** True for the two bands that carry the ▲ glyph as well as color (rule 120). */
export function isOverBand(band: LoadBand): boolean {
  return band === '101-115' || band === 'gt115';
}

/** The chart-layer palette step for a band (#4767 tokens; no colors are defined here). */
export function loadBandCell(band: LoadBand): HeatCell {
  switch (band) {
    case 'none':
      return { kind: 'none' };
    case 'lt40':
      return { kind: 'step', n: 1 };
    case '40-59':
      return { kind: 'step', n: 2 };
    case '60-79':
      return { kind: 'step', n: 3 };
    case '80-100':
      return { kind: 'step', n: 5 };
    case '101-115':
      return { kind: 'over', n: 1 };
    case 'gt115':
      return { kind: 'over', n: 2 };
  }
}
