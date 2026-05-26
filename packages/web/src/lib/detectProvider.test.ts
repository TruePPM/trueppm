import { describe, expect, it } from 'vitest';
import { detectProvider } from './detectProvider';

describe('detectProvider', () => {
  it('detects github.com (with or without www)', () => {
    expect(detectProvider('https://github.com/acme/api/pull/5')).toBe('github');
    expect(detectProvider('https://www.github.com/acme/api/issues/5')).toBe('github');
  });

  it('detects gitlab.com', () => {
    expect(detectProvider('https://gitlab.com/acme/api/-/merge_requests/5')).toBe('gitlab');
  });

  it('falls back to generic for any other well-formed http(s) URL', () => {
    expect(detectProvider('https://bitbucket.org/a/b/pull-requests/1')).toBe('generic');
    expect(detectProvider('https://gitlab.example.com/a/b/-/issues/1')).toBe('generic');
    expect(detectProvider('http://example.com/doc')).toBe('generic');
  });

  it('returns null for empty or unparseable input', () => {
    expect(detectProvider('')).toBeNull();
    expect(detectProvider('   ')).toBeNull();
    expect(detectProvider('not a url')).toBeNull();
    expect(detectProvider('ftp://example.com/x')).toBeNull();
    expect(detectProvider('javascript:alert(1)')).toBeNull();
  });
});
