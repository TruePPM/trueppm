import { describe, it, expect } from 'vitest';
import { wipState, wipTrend } from './wip';
import type { WipState } from './wip';

describe('wipState', () => {
  it("returns 'none' when the limit is null", () => {
    expect(wipState(3, null)).toBe('none');
  });

  it("returns 'none' when the limit is undefined", () => {
    expect(wipState(3, undefined)).toBe('none');
  });

  it("returns 'none' regardless of count when no limit is configured", () => {
    expect(wipState(0, null)).toBe('none');
    expect(wipState(99, null)).toBe('none');
  });

  it("returns 'under' when the count is below the limit", () => {
    expect(wipState(2, 5)).toBe('under');
  });

  it("returns 'at' when the count equals the limit", () => {
    expect(wipState(5, 5)).toBe('at');
  });

  it("returns 'over' when the count exceeds the limit", () => {
    expect(wipState(6, 5)).toBe('over');
  });

  it("treats one below the limit as 'under' and one above as 'over' (boundary)", () => {
    expect(wipState(4, 5)).toBe('under');
    expect(wipState(5, 5)).toBe('at');
    expect(wipState(6, 5)).toBe('over');
  });

  it("returns 'under' for a zero count against a positive limit", () => {
    expect(wipState(0, 5)).toBe('under');
  });

  it("returns 'at' for a zero count against a zero limit (count === limit edge)", () => {
    expect(wipState(0, 0)).toBe('at');
  });

  it("returns 'over' for any positive count against a zero limit", () => {
    expect(wipState(1, 0)).toBe('over');
  });

  it('narrows to the WipState union type', () => {
    const band: WipState = wipState(5, 5);
    expect<WipState>(band).toBe('at');
  });
});

describe('wipTrend', () => {
  it('returns null when no limit is configured', () => {
    expect(wipTrend([1, 2, 3, 4], null)).toBeNull();
    expect(wipTrend([1, 2, 3, 4], undefined)).toBeNull();
  });

  it('returns null with fewer than two data points', () => {
    expect(wipTrend([], 5)).toBeNull();
    expect(wipTrend([3], 5)).toBeNull();
  });

  it('returns null for a flat series (no arrow for no change)', () => {
    expect(wipTrend([4, 4, 4, 4], 6)).toBeNull();
  });

  it("reports 'rising' when the latest count is above the lookback point", () => {
    const t = wipTrend([1, 2, 3, 4], 8);
    expect(t?.direction).toBe('rising');
  });

  it("reports 'falling' when the latest count is below the lookback point", () => {
    const t = wipTrend([5, 4, 3, 2], 8);
    expect(t?.direction).toBe('falling');
  });

  it('flags approaching when rising to within one card of the limit', () => {
    // limit 5, latest 4 → 4 + 1 >= 5 → approaching
    expect(wipTrend([1, 2, 3, 4], 5)).toEqual({ direction: 'rising', approaching: true });
  });

  it('flags approaching when rising at or over the limit', () => {
    expect(wipTrend([3, 4, 5, 6], 5)).toEqual({ direction: 'rising', approaching: true });
  });

  it('does not flag approaching when rising comfortably under the limit', () => {
    // limit 8, latest 4 → 4 + 1 < 8 → informational rise, not at-risk
    expect(wipTrend([1, 2, 3, 4], 8)).toEqual({ direction: 'rising', approaching: false });
  });

  it('never flags approaching on a falling trend, even near the limit', () => {
    expect(wipTrend([8, 7, 6, 5], 5)).toEqual({ direction: 'falling', approaching: false });
  });

  it('compares against the lookback window, not the whole series', () => {
    // 7-day series, default lookback 3: compares last (2) to index 3 (5) → falling,
    // even though the earliest value (1) is below the latest.
    expect(wipTrend([1, 3, 5, 5, 4, 3, 2], 6)?.direction).toBe('falling');
  });

  it('clamps the lookback to the series start on short series', () => {
    // length 2, lookback 3 → prior clamps to index 0; 5 > 2 → rising, 5+1 < 8 → not at-risk
    expect(wipTrend([2, 5], 8)).toEqual({ direction: 'rising', approaching: false });
  });

  it('honors a custom lookback window', () => {
    // compare latest (4) to one step back (3) → rising
    expect(wipTrend([1, 9, 3, 4], 8, 1)?.direction).toBe('rising');
  });

  it('treats a suppressed/absent series (empty array) as no trend', () => {
    // The caller passes [] under ADR-0104 suppression or for a status with no CFD.
    expect(wipTrend([], 5)).toBeNull();
  });
});
