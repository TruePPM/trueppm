import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { isRateLimited, retryAfterSeconds, waitPhrase } from './rateLimit';

function err(status: number, headers: Record<string, string> = {}, data: unknown = {}) {
  return new AxiosError('x', 'ERR', undefined, undefined, {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(headers),
    config: { headers: new AxiosHeaders() },
  });
}

describe('rateLimit helpers', () => {
  it('detects only 429', () => {
    expect(isRateLimited(err(429))).toBe(true);
    expect(isRateLimited(err(401))).toBe(false);
    expect(isRateLimited(new Error('x'))).toBe(false);
  });
  it('reads Retry-After seconds', () => {
    expect(retryAfterSeconds(err(429, { 'retry-after': '17' }))).toBe(17);
  });
  it('reads a Retry-After HTTP date, rounding up', () => {
    const when = new Date(Date.now() + 30_000).toUTCString();
    const s = retryAfterSeconds(err(429, { 'retry-after': when }));
    expect(s).toBeGreaterThanOrEqual(28);
    expect(s).toBeLessThanOrEqual(31);
  });
  it('falls back to the DRF body', () => {
    expect(retryAfterSeconds(err(429, {}, { wait: 4.2 }))).toBe(5);
    expect(
      retryAfterSeconds(err(429, {}, { detail: 'Request was throttled. Expected available in 42 seconds.' })),
    ).toBe(42);
  });
  it('is null when the server named no wait, or the error is not a 429', () => {
    expect(retryAfterSeconds(err(429))).toBeNull();
    expect(retryAfterSeconds(err(500, { 'retry-after': '3' }))).toBeNull();
  });
  it('phrases the wait', () => {
    expect(waitPhrase(null)).toBe('in a moment');
    expect(waitPhrase(1)).toBe('in 1 second');
    expect(waitPhrase(45)).toBe('in 45 seconds');
    expect(waitPhrase(65)).toBe('in 1 minute 5 seconds');
  });
});
