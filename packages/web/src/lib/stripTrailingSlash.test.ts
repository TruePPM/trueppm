import { describe, expect, it } from 'vitest';
import { stripTrailingSlash } from './stripTrailingSlash';

describe('stripTrailingSlash (#2519)', () => {
  it('drops a single trailing slash', () => {
    expect(stripTrailingSlash('https://idp.example.com/')).toBe('https://idp.example.com');
  });

  it('drops a run of trailing slashes', () => {
    expect(stripTrailingSlash('https://idp.example.com///')).toBe('https://idp.example.com');
  });

  it('leaves a string with no trailing slash untouched', () => {
    expect(stripTrailingSlash('https://idp.example.com')).toBe('https://idp.example.com');
  });

  it('leaves interior slashes alone', () => {
    expect(stripTrailingSlash('https://idp.example.com/realms/tp/')).toBe(
      'https://idp.example.com/realms/tp',
    );
  });

  it('handles the empty string and an all-slash string', () => {
    expect(stripTrailingSlash('')).toBe('');
    expect(stripTrailingSlash('///')).toBe('');
  });

  // The shape that made the old `/\/+$/` super-linear: trailing slashes that are
  // not actually at the end, so the greedy match fails and retries per position.
  it('is unchanged when the slashes are not at the end', () => {
    expect(stripTrailingSlash('///x')).toBe('///x');
    expect(stripTrailingSlash(`${'/'.repeat(50_000)}x`)).toBe(`${'/'.repeat(50_000)}x`);
  });

  // The scan indexes the string rather than comparing code units (#2566). A string
  // ending in an astral character ends in a lone trail surrogate at `end - 1`, which
  // is not `/` — so the scan stops there and the input survives intact.
  it('leaves a trailing astral character alone', () => {
    expect(stripTrailingSlash('a🚀')).toBe('a🚀');
    expect(stripTrailingSlash('a🚀//')).toBe('a🚀');
  });
});
