import { describe, it, expect } from 'vitest';
import { BLOCKER_TYPES, blockerTypeLabel, formatBlockedAge } from './blocker';

describe('formatBlockedAge', () => {
  it('returns null for null/undefined age (not flagged)', () => {
    expect(formatBlockedAge(null)).toBeNull();
    expect(formatBlockedAge(undefined)).toBeNull();
  });

  it('renders "just now" under an hour', () => {
    expect(formatBlockedAge(0)).toBe('just now');
    expect(formatBlockedAge(59 * 60)).toBe('just now');
  });

  it('renders hours when under a day', () => {
    expect(formatBlockedAge(3600)).toBe('1h blocked');
    expect(formatBlockedAge(5 * 3600)).toBe('5h blocked');
  });

  it('renders days and hours past a day', () => {
    expect(formatBlockedAge(86400)).toBe('1d blocked');
    expect(formatBlockedAge(86400 + 2 * 3600)).toBe('1d 2h blocked');
  });

  it('clamps negative ages to "just now"', () => {
    expect(formatBlockedAge(-500)).toBe('just now');
  });
});

describe('blockerTypeLabel', () => {
  it('maps each known type to its label', () => {
    expect(blockerTypeLabel('vendor')).toBe('External vendor');
    expect(blockerTypeLabel('decision')).toBe('Decision needed');
    for (const t of BLOCKER_TYPES) {
      expect(blockerTypeLabel(t)).toBeTruthy();
    }
  });

  it('returns null for empty/nullish', () => {
    expect(blockerTypeLabel('')).toBeNull();
    expect(blockerTypeLabel(null)).toBeNull();
    expect(blockerTypeLabel(undefined)).toBeNull();
  });

  it('falls back to the raw code for an unknown type', () => {
    expect(blockerTypeLabel('mystery')).toBe('mystery');
  });
});
