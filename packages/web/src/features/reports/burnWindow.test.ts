import { describe, it, expect } from 'vitest';
import { daysBetween, isWindowClamped } from './burnWindow';

describe('isWindowClamped', () => {
  it('is false without an echoed window', () => {
    expect(isWindowClamped(undefined, undefined)).toBe(false);
  });

  it('flags a requested since the server moved', () => {
    expect(
      isWindowClamped('2025-01-01', { since: '2025-06-01', until: '2026-06-01' }),
    ).toBe(true);
    expect(
      isWindowClamped('2025-06-01', { since: '2025-06-01', until: '2026-06-01' }),
    ).toBe(false);
  });

  it('treats a window of exactly the max span as clamped (the server clamps to exactly 366)', () => {
    const echoed = { since: '2025-01-01', until: '2026-01-02' };
    expect(daysBetween(echoed.since, echoed.until)).toBe(366);
    expect(isWindowClamped(undefined, echoed)).toBe(true);
  });

  it('is not clamped one day under the max span', () => {
    expect(isWindowClamped(undefined, { since: '2025-01-02', until: '2026-01-02' })).toBe(false);
  });
});
