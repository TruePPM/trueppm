import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { supportCode } from './supportCode';

const AT = new Date('2026-11-07T09:05:03Z');

describe('supportCode', () => {
  it('pairs the HTTP status with the UTC time to the second', () => {
    const err = new AxiosError('x', 'ERR', undefined, undefined, {
      status: 503,
      statusText: '',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: null,
    });
    expect(supportCode(err, AT)).toBe('503-090503');
  });

  it('says NET when the request got no response', () => {
    expect(supportCode(new AxiosError('offline'), AT)).toBe('NET-090503');
  });

  it('says APP for a failure that was not a request', () => {
    expect(supportCode(new TypeError('boom'), AT)).toBe('APP-090503');
  });
});
