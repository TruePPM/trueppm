import { describe, it, expect } from 'vitest';
import { initialsOf } from './initials';

describe('initialsOf', () => {
  it('takes the first letter of the first and last word', () => {
    expect(initialsOf('Grace Hopper')).toBe('GH');
    expect(initialsOf('Ada Lovelace King')).toBe('AK');
  });

  it('takes the first two letters of a single name', () => {
    expect(initialsOf('Cher')).toBe('CH');
    expect(initialsOf('x')).toBe('X');
  });

  it('collapses extra whitespace', () => {
    expect(initialsOf('  Grace   Hopper  ')).toBe('GH');
  });

  it('returns null for an empty or whitespace-only name', () => {
    expect(initialsOf('')).toBeNull();
    expect(initialsOf('   ')).toBeNull();
  });
});
