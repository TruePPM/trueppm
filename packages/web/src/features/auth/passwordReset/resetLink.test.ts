import { describe, expect, it } from 'vitest';
import { buildResetConfirmPath, parseResetCredential } from './resetLink';

describe('parseResetCredential', () => {
  it('reads uid and token from a fragment carrying the leading #', () => {
    expect(parseResetCredential('#uid=MQ&token=abc-def')).toEqual({
      uid: 'MQ',
      token: 'abc-def',
    });
  });

  it('reads a fragment passed without the leading #', () => {
    expect(parseResetCredential('uid=MQ&token=abc-def')).toEqual({ uid: 'MQ', token: 'abc-def' });
  });

  it('is order-independent', () => {
    expect(parseResetCredential('#token=abc-def&uid=MQ')).toEqual({
      uid: 'MQ',
      token: 'abc-def',
    });
  });

  it('percent-decodes values', () => {
    expect(parseResetCredential('#uid=a%2Bb&token=c%2Fd')).toEqual({ uid: 'a+b', token: 'c/d' });
  });

  it('ignores unrelated fragment keys', () => {
    expect(parseResetCredential('#next=%2Fhome&uid=MQ&token=abc')).toEqual({
      uid: 'MQ',
      token: 'abc',
    });
  });

  it.each([
    ['an empty fragment', ''],
    ['a bare hash', '#'],
    ['a fragment with neither key', '#foo=bar'],
    ['uid with no token', '#uid=MQ'],
    ['token with no uid', '#token=abc'],
    ['an empty uid', '#uid=&token=abc'],
    ['an empty token', '#uid=MQ&token='],
  ])('returns null for %s', (_label, hash) => {
    expect(parseResetCredential(hash)).toBeNull();
  });
});

describe('buildResetConfirmPath', () => {
  it('puts the credential in the fragment, never the path or the query', () => {
    const path = buildResetConfirmPath({ uid: 'MQ', token: 'abc-def' });

    expect(path).toBe('/reset-password/confirm#uid=MQ&token=abc-def');
    // The part before the `#` is what a server, a proxy log, a `Referer` header
    // and `window.location.pathname` can all see — it must carry no credential.
    const [beforeHash] = path.split('#');
    expect(beforeHash).toBe('/reset-password/confirm');
    expect(beforeHash).not.toContain('MQ');
    expect(beforeHash).not.toContain('abc-def');
    expect(path).not.toContain('?');
  });

  it('percent-encodes a credential containing URL-significant characters', () => {
    const path = buildResetConfirmPath({ uid: 'a+b', token: 'c/d&e' });

    expect(path).toBe('/reset-password/confirm#uid=a%2Bb&token=c%2Fd%26e');
    expect(parseResetCredential(path.slice(path.indexOf('#')))).toEqual({
      uid: 'a+b',
      token: 'c/d&e',
    });
  });
});
