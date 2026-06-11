import { describe, it, expect } from 'vitest';
import { previewScore, type ScoringInputValues } from './scorePreview';

describe('previewScore — mirrors the server compute_score', () => {
  it('WSJF = (bv + tc + rr) / job_size', () => {
    expect(
      previewScore('wsjf', {
        businessValue: 8,
        timeCriticality: 5,
        riskReduction: 5,
        jobSize: 4,
      }),
    ).toBeCloseTo(4.5);
  });

  it('RICE = (reach * impact * confidence) / effort', () => {
    expect(
      previewScore('rice', { reach: 100, impact: 2, confidence: 0.8, effort: 4 }),
    ).toBeCloseTo(40);
  });

  it('VALUE_EFFORT = value / effort_estimate', () => {
    expect(previewScore('value_effort', { value: 9, effortEstimate: 3 })).toBeCloseTo(3);
  });

  it('returns null when any required input is missing', () => {
    expect(
      previewScore('wsjf', { businessValue: 8, timeCriticality: 5, jobSize: 4 }),
    ).toBeNull(); // riskReduction missing
    expect(previewScore('rice', { reach: 100, impact: 2, confidence: 0.8 })).toBeNull(); // effort missing
    expect(previewScore('value_effort', { value: 9 })).toBeNull(); // effortEstimate missing
  });

  it('returns null (not Infinity) when the denominator is zero — the falsy-guard trap', () => {
    expect(
      previewScore('wsjf', {
        businessValue: 8,
        timeCriticality: 5,
        riskReduction: 5,
        jobSize: 0,
      }),
    ).toBeNull();
    expect(
      previewScore('rice', { reach: 100, impact: 2, confidence: 0.8, effort: 0 }),
    ).toBeNull();
    expect(previewScore('value_effort', { value: 9, effortEstimate: 0 })).toBeNull();
  });

  it('treats a zero numerator input as a real value, not missing', () => {
    // bv=0 is a legitimate score input; only the denominator falsy-guards to null.
    expect(
      previewScore('wsjf', {
        businessValue: 0,
        timeCriticality: 0,
        riskReduction: 0,
        jobSize: 4,
      }),
    ).toBe(0);
  });

  it('returns null for the none model', () => {
    expect(previewScore('none', {} as ScoringInputValues)).toBeNull();
  });
});
