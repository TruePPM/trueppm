import { describe, it, expect } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  STRENGTH_LABELS,
  allRequirementsMet,
  checkRequirements,
  passwordScore,
  strengthLabel,
} from './passwordStrength';

describe('passwordScore', () => {
  it('scores an empty password 0 (Too weak)', () => {
    expect(passwordScore('')).toBe(0);
    expect(strengthLabel(passwordScore(''))).toBe('Too weak');
  });

  it('never rates a password below the min length above Weak (1)', () => {
    // 'aB3$' has 3 character classes but is only 4 chars — must stay capped at Weak.
    expect(passwordScore('aB3$')).toBeLessThanOrEqual(1);
    expect(passwordScore('short1!')).toBeLessThanOrEqual(1);
  });

  it('rates a long, diverse password Excellent (4)', () => {
    expect(passwordScore('Tr0ub4dor&3xkcd')).toBe(4);
    expect(strengthLabel(passwordScore('Tr0ub4dor&3xkcd'))).toBe('Excellent');
  });

  it('rates a long single-class password in the middle, not the top', () => {
    // 12 chars → 2 length points; a single character class earns 0 diversity
    // points (the first diversity point needs ≥2 classes) → 2 (Fair).
    const score = passwordScore('abcdefghijkl');
    expect(score).toBe(2);
    expect(strengthLabel(score)).toBe('Fair');
  });

  it('is monotonic-ish: adding length and diversity does not lower the score', () => {
    const weak = passwordScore('aaaaaaaaaa'); // 10 chars, 1 class
    const strong = passwordScore('aaaaaAAAA1!'); // longer + more classes
    expect(strong).toBeGreaterThanOrEqual(weak);
  });

  it('caps the score at 4', () => {
    expect(passwordScore('SuperLong&Diverse123456789!')).toBe(4);
  });

  it('has exactly five labels aligned to scores 0–4', () => {
    expect(STRENGTH_LABELS).toHaveLength(5);
    for (let s = 0 as 0 | 1 | 2 | 3 | 4; s <= 4; s = (s + 1) as 0 | 1 | 2 | 3 | 4) {
      expect(typeof strengthLabel(s)).toBe('string');
    }
  });
});

describe('checkRequirements', () => {
  it('flags a too-short password as failing length', () => {
    expect(checkRequirements('ab1').length).toBe(false);
  });

  it('passes length at exactly the minimum', () => {
    expect(checkRequirements('a'.repeat(MIN_PASSWORD_LENGTH)).length).toBe(true);
  });

  it('detects a digit as satisfying numberOrSymbol', () => {
    expect(checkRequirements('abcdefghi1').numberOrSymbol).toBe(true);
  });

  it('detects a symbol as satisfying numberOrSymbol', () => {
    expect(checkRequirements('abcdefghi!').numberOrSymbol).toBe(true);
  });

  it('fails numberOrSymbol for a pure-letter password', () => {
    expect(checkRequirements('abcdefghij').numberOrSymbol).toBe(false);
  });
});

describe('allRequirementsMet', () => {
  it('is true only when length AND numberOrSymbol both pass', () => {
    expect(allRequirementsMet('abcdefghi1')).toBe(true); // 10 chars + digit
    expect(allRequirementsMet('abcdefghij')).toBe(false); // no number/symbol
    expect(allRequirementsMet('abc1')).toBe(false); // too short
  });
});
