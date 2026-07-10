import { describe, it, expect } from 'vitest';
import { labelForUser, initialsForUser, accountAccessibleName } from './userIdentity';

describe('labelForUser', () => {
  it('prefers display_name', () => {
    expect(
      labelForUser({ display_name: 'Kelly Hair', username: 'khair', email: 'k@x.com' }),
    ).toBe('Kelly Hair');
  });

  it('falls back to username when display_name is blank', () => {
    expect(labelForUser({ display_name: '  ', username: 'khair', email: 'k@x.com' })).toBe('khair');
  });

  it('falls back to the email local-part when name and username are blank', () => {
    expect(labelForUser({ display_name: '', username: '', email: 'kelly.hair@x.com' })).toBe(
      'kelly.hair',
    );
  });

  it('returns "Account" only when nothing is available', () => {
    expect(labelForUser(undefined)).toBe('Account');
    expect(labelForUser({})).toBe('Account');
  });
});

describe('initialsForUser', () => {
  it('derives from display_name', () => {
    expect(initialsForUser({ display_name: 'Kelly Hair' })).toBe('KH');
  });

  it('falls back to username initials', () => {
    expect(initialsForUser({ display_name: '', username: 'Ada' })).toBe('AD');
  });

  it('falls back to the email local-part, treating separators as word boundaries', () => {
    expect(initialsForUser({ email: 'kelly.hair@x.com' })).toBe('KH');
    expect(initialsForUser({ email: 'kelly_hair@x.com' })).toBe('KH');
    expect(initialsForUser({ email: 'kelly@x.com' })).toBe('KE');
  });

  it('never renders "?" — uses a neutral placeholder for an unresolved session', () => {
    expect(initialsForUser(undefined)).toBe('··');
    expect(initialsForUser({})).toBe('··');
    expect(initialsForUser({ display_name: '   ', username: '', email: '' })).toBe('··');
  });
});

describe('accountAccessibleName', () => {
  it('includes the resolved name so the chip self-identifies', () => {
    expect(accountAccessibleName({ display_name: 'Kelly Hair' })).toBe('Account — Kelly Hair');
    expect(accountAccessibleName({ username: 'khair' })).toBe('Account — khair');
    expect(accountAccessibleName({ email: 'kelly.hair@x.com' })).toBe('Account — kelly.hair');
  });

  it('falls back to a bare "Account" only for an unresolved session', () => {
    expect(accountAccessibleName(undefined)).toBe('Account');
    expect(accountAccessibleName({})).toBe('Account');
  });
});
