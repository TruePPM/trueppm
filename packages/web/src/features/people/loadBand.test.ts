import { describe, expect, it } from 'vitest';
import { isOverBand, loadBand, loadBandCell, LOAD_BANDS, LOAD_BAND_LABEL } from './loadBand';

describe('loadBand', () => {
  it.each([
    [0, 'lt40'],
    [39, 'lt40'],
    [40, '40-59'],
    [59, '40-59'],
    [60, '60-79'],
    [79, '60-79'],
    [80, '80-100'],
    [100, '80-100'],
    [101, '101-115'],
    [115, '101-115'],
    [116, 'gt115'],
    [240, 'gt115'],
  ] as const)('bins %d%% as %s', (pct, band) => {
    expect(loadBand(pct)).toBe(band);
  });

  it('reads a week the server could not compute as none, never as a 0% band', () => {
    expect(loadBand(null)).toBe('none');
    expect(loadBand(undefined)).toBe('none');
    expect(loadBand(Number.NaN)).toBe('none');
    expect(loadBand(-5)).toBe('none');
  });

  it('marks exactly the two over-allocated bands for the glyph', () => {
    expect(LOAD_BANDS.filter(isOverBand)).toEqual(['101-115', 'gt115']);
    expect(isOverBand('none')).toBe(false);
  });

  it('labels the legend as the design writes it', () => {
    expect(LOAD_BANDS.map((b) => LOAD_BAND_LABEL[b]).join(' · ')).toBe(
      '<40 · 40–59 · 60–79 · 80–100 · 101–115 · >115',
    );
  });

  it('maps bands onto the chart-layer palette, sequential then the over pair', () => {
    expect(LOAD_BANDS.map((b) => loadBandCell(b))).toEqual([
      { kind: 'step', n: 1 },
      { kind: 'step', n: 2 },
      { kind: 'step', n: 3 },
      { kind: 'step', n: 5 },
      { kind: 'over', n: 1 },
      { kind: 'over', n: 2 },
    ]);
    expect(loadBandCell('none')).toEqual({ kind: 'none' });
  });
});
