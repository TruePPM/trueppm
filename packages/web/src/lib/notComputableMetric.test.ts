import { describe, it, expect } from 'vitest';
import { isNotComputable, isZeroValue, NOT_COMPUTABLE_REASON } from './notComputableMetric';

describe('isNotComputable', () => {
  it('is true for a zero denominator', () => {
    expect(isNotComputable(0)).toBe(true);
  });

  it('is true for a null or undefined denominator', () => {
    expect(isNotComputable(null)).toBe(true);
    expect(isNotComputable(undefined)).toBe(true);
  });

  it('is true for a negative denominator (defensive — should never occur)', () => {
    expect(isNotComputable(-1)).toBe(true);
  });

  it('is false for any positive denominator', () => {
    expect(isNotComputable(1)).toBe(false);
    expect(isNotComputable(34)).toBe(false);
  });
});

describe('isZeroValue', () => {
  it('is true only for an exact zero', () => {
    expect(isZeroValue(0)).toBe(true);
  });

  it('is false for null, undefined, or any nonzero number', () => {
    expect(isZeroValue(null)).toBe(false);
    expect(isZeroValue(undefined)).toBe(false);
    expect(isZeroValue(1)).toBe(false);
    expect(isZeroValue(-1)).toBe(false);
  });
});

describe('NOT_COMPUTABLE_REASON', () => {
  it('is the shared reason text every not-computable card renders', () => {
    expect(NOT_COMPUTABLE_REASON).toBe('No assignments yet');
  });
});
