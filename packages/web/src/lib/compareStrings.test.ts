import { describe, it, expect } from 'vitest';
import { compareCodeUnits } from './compareStrings';

describe('compareCodeUnits', () => {
  it('orders by UTF-16 code unit', () => {
    expect(compareCodeUnits('a', 'b')).toBe(-1);
    expect(compareCodeUnits('b', 'a')).toBe(1);
    expect(compareCodeUnits('a', 'a')).toBe(0);
  });

  it('is case-sensitive where collation is not', () => {
    // 'B' (0x42) precedes 'a' (0x61) by code unit; collation puts 'a' first.
    // The divergence is the whole reason a persisted key must not use
    // `localeCompare` — the two comparators disagree on the same pair.
    expect(compareCodeUnits('B', 'a')).toBe(-1);
    expect('B'.localeCompare('a')).toBeGreaterThan(0);
  });

  it('agrees with a bare sort(), which is what it makes explicit', () => {
    const ids = ['b2', 'A1', 'a-3', 'a3', '0f'];
    expect([...ids].sort(compareCodeUnits)).toEqual([...ids].sort());
  });

  it('is a total order, so sorting is idempotent', () => {
    const ids = ['9f1', '0a2', '9f1', 'ffe'];
    const once = [...ids].sort(compareCodeUnits);
    expect([...once].sort(compareCodeUnits)).toEqual(once);
  });
});
