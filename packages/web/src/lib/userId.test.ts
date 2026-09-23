import { describe, expect, it } from 'vitest';
import { isSameUser } from './userId';

describe('isSameUser (#2633)', () => {
  it('matches /auth/me/ string id against an integer FK of the same user', () => {
    expect(isSameUser(5, '5')).toBe(true);
    expect(isSameUser('5', 5)).toBe(true);
  });

  it('matches same-encoding ids', () => {
    expect(isSameUser(5, 5)).toBe(true);
    expect(isSameUser('5', '5')).toBe(true);
  });

  it('rejects different users', () => {
    expect(isSameUser(5, '50')).toBe(false);
    expect(isSameUser(5, 6)).toBe(false);
  });

  it('never matches an absent id, even against another absent id', () => {
    expect(isSameUser(null, null)).toBe(false);
    expect(isSameUser(undefined, '5')).toBe(false);
    expect(isSameUser(5, null)).toBe(false);
    expect(isSameUser('', '')).toBe(false);
  });
});
