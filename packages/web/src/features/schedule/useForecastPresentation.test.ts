import { describe, it, expect } from 'vitest';
import { forecastPresentation, isZeroSpread } from './useForecastPresentation';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import type { MonteCarloResult } from '@/types';

function result(overrides: Partial<MonteCarloResult> = {}): MonteCarloResult {
  return { ...FIXTURE_MC_RESULT, ...overrides };
}

/** Every trial returned the same date — the degenerate run from the report. */
function degenerate(overrides: Partial<MonteCarloResult> = {}): MonteCarloResult {
  return result({ p50: '2026-10-06', p80: '2026-10-06', p95: '2026-10-06', ...overrides });
}

describe('forecastPresentation', () => {
  it('reports notRun with no chips when there is no result', () => {
    expect(forecastPresentation(null)).toEqual({
      state: 'notRun',
      chips: [],
      note: '',
      baseline: null,
    });
  });

  describe('zero spread', () => {
    it('collapses to a single chip — three identical chips imply a spread that is not there', () => {
      const p = forecastPresentation(degenerate());
      expect(p.state).toBe('zeroSpread');
      expect(p.chips).toHaveLength(1);
      expect(p.chips[0].text).toBe('Forecast: Oct 6 · +29d vs CPM (Oct 5)');
    });

    it('suppresses the percentile keys rather than zeroing them', () => {
      // "P80" on a single-value result is a claim about a distribution.
      const p = forecastPresentation(degenerate());
      expect(p.chips.map((c) => c.text).join(' ')).not.toMatch(/P50|P80|P95/);
    });

    it('states the date, and defers the reason to the server diagnostic', () => {
      const p = forecastPresentation(degenerate());
      expect(p.note).toContain('Every simulation finished on October 6, 2026');
      expect(p.note).toContain('No date spread to plot');
    });

    it('says "matches CPM" in words rather than rendering "+0d"', () => {
      const p = forecastPresentation(
        degenerate({ deltaVsCpm: { ...FIXTURE_MC_RESULT.deltaVsCpm, p80: 0 } }),
      );
      expect(p.chips[0].text).toBe('Forecast: Oct 6 · matches CPM');
    });

    it('tints a forecast ahead of CPM as on-track and keeps the signed value', () => {
      const p = forecastPresentation(
        degenerate({ deltaVsCpm: { ...FIXTURE_MC_RESULT.deltaVsCpm, p80: -4 } }),
      );
      expect(p.chips[0].text).toBe('Forecast: Oct 6 · -4d vs CPM (Oct 5)');
      expect(p.chips[0].textClass).toBe('text-semantic-on-track');
    });

    it('drops the delta clause entirely when there is no baseline to name', () => {
      // Never a delta without the date it is measured from — an unanchored "+29d"
      // is the unreadable form this issue exists to remove.
      const p = forecastPresentation(degenerate({ cpmFinish: null }));
      expect(p.chips[0].text).toBe('Forecast: Oct 6');
      expect(p.baseline).toBeNull();
    });
  });

  describe('real spread', () => {
    it('keeps the three percentile chips and appends a dashed CPM reference chip', () => {
      const p = forecastPresentation(result());
      expect(p.state).toBe('spread');
      expect(p.chips.map((c) => c.key)).toEqual(['p50', 'p80', 'p95', 'cpm']);
      expect(p.chips[3].dashed).toBe(true);
    });

    it('renders the delta once, on the commit chip', () => {
      const p = forecastPresentation(result());
      const withDelta = p.chips.filter((c) => /[+-]\d+d/.test(c.text));
      expect(withDelta).toHaveLength(1);
      expect(withDelta[0].key).toBe('p80');
    });

    it('omits the reference chip and the delta when no CPM finish is known', () => {
      const p = forecastPresentation(result({ cpmFinish: null }));
      expect(p.chips.map((c) => c.key)).toEqual(['p50', 'p80', 'p95']);
      expect(p.chips[1].text).not.toMatch(/[+-]\d+d/);
    });

    it('falls back to the caller-supplied CPM finish when the payload has none', () => {
      const p = forecastPresentation(result({ cpmFinish: null }), '2026-10-05');
      expect(p.baseline?.iso).toBe('2026-10-05');
      expect(p.chips.at(-1)?.text).toBe('CPM: Oct 5');
    });

    it('carries no note — the note is the degenerate-run explanation', () => {
      expect(forecastPresentation(result()).note).toBe('');
    });
  });
});

describe('isZeroSpread', () => {
  it('matches on all three percentiles being the same ISO date', () => {
    expect(isZeroSpread(degenerate())).toBe(true);
    expect(isZeroSpread(result())).toBe(false);
  });
});
