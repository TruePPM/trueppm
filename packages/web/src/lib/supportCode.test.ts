import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { supportCode } from './supportCode';

const AT = new Date('2026-11-07T09:05:03Z');

function httpError(status: number, headers: Record<string, string> = {}) {
  return new AxiosError('x', 'ERR', undefined, undefined, {
    status,
    statusText: '',
    headers,
    config: { headers: new AxiosHeaders() },
    data: null,
  });
}

describe('supportCode', () => {
  it("prefers the response's X-Request-ID — the id the API's log lines carry", () => {
    const err = httpError(503, { 'x-request-id': '9f3c2a1be47d4c0f8a6b5e2d1c0f9a8b' });
    expect(supportCode(err, AT)).toBe('503-9f3c2a1b');
  });

  it('strips anything but alphanumerics from an adopted inbound id', () => {
    expect(supportCode(httpError(500, { 'x-request-id': 'ab-cd_ef.gh12' }), AT)).toBe(
      '500-abcdefgh',
    );
  });

  it('falls back to status + UTC time when the header is absent or unreadable', () => {
    expect(supportCode(httpError(503), AT)).toBe('503-090503');
  });

  it('says NET when the request got no response', () => {
    expect(supportCode(new AxiosError('offline'), AT)).toBe('NET-090503');
  });

  it('says APP for a failure that was not a request', () => {
    expect(supportCode(new TypeError('boom'), AT)).toBe('APP-090503');
  });
});
