import { describe, it, expect } from 'vitest';
import { wipState } from './wip';
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
