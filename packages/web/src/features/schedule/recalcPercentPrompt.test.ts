import { describe, it, expect } from 'vitest';
import { proratedPercent, shouldPromptRecalc, buildRecalcPrompt } from './recalcPercentPrompt';

describe('proratedPercent', () => {
  it('scales by the duration ratio, rounded to one decimal', () => {
    // 30% on 5d → 10d halves to 15%.
    expect(proratedPercent(30, 5, 10)).toBe(15);
    // 50% on 4d → 6d = 33.333… → 33.3.
    expect(proratedPercent(50, 4, 6)).toBe(33.3);
  });

  it('clamps to [0, 100]', () => {
    // Shrinking duration can push the prorated value above 100 — clamp it.
    expect(proratedPercent(80, 10, 4)).toBe(100);
    expect(proratedPercent(0, 5, 10)).toBe(0);
  });

  it('returns the old percent unchanged for a non-positive new duration', () => {
    expect(proratedPercent(40, 5, 0)).toBe(40);
  });
});

describe('shouldPromptRecalc', () => {
  const base = { policy: 'confirm' as const, oldPercent: 30, oldDuration: 5, newDuration: 10, suppressed: false };

  it('prompts under confirm when progress exists and the duration changed', () => {
    expect(shouldPromptRecalc(base)).toBe(true);
  });

  it('never prompts when suppressed (coarse pointer / mobile)', () => {
    expect(shouldPromptRecalc({ ...base, suppressed: true })).toBe(false);
  });

  it('never prompts under keep or prorate', () => {
    expect(shouldPromptRecalc({ ...base, policy: 'keep' })).toBe(false);
    expect(shouldPromptRecalc({ ...base, policy: 'prorate' })).toBe(false);
  });

  it('never prompts when there is no progress', () => {
    expect(shouldPromptRecalc({ ...base, oldPercent: 0 })).toBe(false);
  });

  it('never prompts when the duration did not change or is non-positive', () => {
    expect(shouldPromptRecalc({ ...base, newDuration: 5 })).toBe(false);
    expect(shouldPromptRecalc({ ...base, newDuration: 0 })).toBe(false);
  });
});

describe('buildRecalcPrompt', () => {
  it('returns the prompt state with the prorated suggestion for a qualifying edit', () => {
    const prompt = buildRecalcPrompt({
      taskId: 't1',
      policy: 'confirm',
      oldPercent: 30,
      oldDuration: 5,
      newDuration: 10,
      suppressed: false,
    });
    expect(prompt).toEqual({
      taskId: 't1',
      oldDuration: 5,
      newDuration: 10,
      oldPercent: 30,
      suggestedPercent: 15,
    });
  });

  it('returns null for a non-qualifying edit', () => {
    expect(
      buildRecalcPrompt({
        taskId: 't1',
        policy: 'keep',
        oldPercent: 30,
        oldDuration: 5,
        newDuration: 10,
        suppressed: false,
      }),
    ).toBeNull();
  });
});
