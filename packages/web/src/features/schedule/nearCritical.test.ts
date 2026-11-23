import { describe, expect, it } from 'vitest';
import { isNearCriticalByFloat } from './nearCritical';

describe('isNearCriticalByFloat (#4796)', () => {
  it('matches the server bands: 0 < float <= threshold, non-critical only', () => {
    expect(isNearCriticalByFloat({ isCritical: false, totalFloat: 1 }, 5)).toBe(true);
    expect(isNearCriticalByFloat({ isCritical: false, totalFloat: 5 }, 5)).toBe(true);
    expect(isNearCriticalByFloat({ isCritical: false, totalFloat: 6 }, 5)).toBe(false);
    expect(isNearCriticalByFloat({ isCritical: false, totalFloat: 0 }, 5)).toBe(false);
    expect(isNearCriticalByFloat({ isCritical: true, totalFloat: 2 }, 5)).toBe(false);
  });

  it('is false until the threshold and the float are known', () => {
    expect(isNearCriticalByFloat({ isCritical: false, totalFloat: 2 }, null)).toBe(false);
    expect(isNearCriticalByFloat({ isCritical: false, totalFloat: 2 }, undefined)).toBe(false);
    expect(isNearCriticalByFloat({ isCritical: false, totalFloat: null }, 5)).toBe(false);
    expect(isNearCriticalByFloat({ isCritical: false }, 5)).toBe(false);
  });
});
