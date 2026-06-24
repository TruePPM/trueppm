import { describe, it, expect } from 'vitest';
import { isPokerOutlier, outlierValue } from './pokerOutlier';

describe('isPokerOutlier', () => {
  it('is false with fewer than two numeric votes', () => {
    expect(isPokerOutlier([])).toBe(false);
    expect(isPokerOutlier([5])).toBe(false);
    expect(isPokerOutlier([8, null])).toBe(false); // null excluded → one numeric vote
  });

  it('is false for a tight spread', () => {
    expect(isPokerOutlier([5, 5, 8])).toBe(false); // median 5, step 3, 2×=6 > spread 3
    expect(isPokerOutlier([3, 3, 3])).toBe(false);
  });

  it('is true when the spread is ≥ 2× the step at the median', () => {
    // median 8, step to next card (13) = 5, 2×5 = 10, spread = 10 → outlier
    expect(isPokerOutlier([3, 13])).toBe(true);
    // median ≈ 13, step 8, 2×8 = 16, spread 20 → outlier
    expect(isPokerOutlier([1, 21])).toBe(true);
  });

  it('excludes "?" (null) votes from the calculation', () => {
    expect(isPokerOutlier([3, null, 13])).toBe(true);
    expect(isPokerOutlier([5, null, 8])).toBe(false);
  });
});

describe('outlierValue', () => {
  it('returns null when the round is not an outlier', () => {
    expect(outlierValue([5, 5, 8])).toBeNull();
  });

  it('returns the value furthest from the median (high card wins ties)', () => {
    expect(outlierValue([3, 13])).toBe(13); // symmetric → high
    expect(outlierValue([5, 5, 5, 21])).toBe(21); // 21 is the lone high outlier
    expect(outlierValue([1, 21, 21])).toBe(1); // median 21 → 1 is the lone low outlier
  });
});
