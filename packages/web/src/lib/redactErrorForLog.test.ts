import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { redactErrorForLog } from './redactErrorForLog';

const TOKEN = 'Bearer secret-access-token-123';

function makeAxiosError(url: string, status?: number): AxiosError {
  const config = {
    method: 'get',
    url,
    headers: new AxiosHeaders({ Authorization: TOKEN }),
    data: '{"password":"hunter2"}',
  } as InternalAxiosRequestConfig;
  const response =
    status === undefined
      ? undefined
      : { status, statusText: '', data: {}, headers: {}, config };
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, {}, response);
}

describe('redactErrorForLog', () => {
  it('keeps method, path and status for an AxiosError and drops headers and body', () => {
    const out = redactErrorForLog(makeAxiosError('/api/v1/tasks/?token=abc#frag', 500));
    expect(out).toMatchObject({
      name: 'AxiosError',
      message: 'Request failed',
      method: 'GET',
      path: '/api/v1/tasks/',
      status: 500,
      code: 'ERR_BAD_RESPONSE',
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain('secret-access-token');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('token=abc');
  });

  it('strips origin and query from an absolute URL', () => {
    const out = redactErrorForLog(makeAxiosError('https://api.example.com/v1/x?k=1'));
    expect(out.path).toBe('/v1/x');
    expect(out.status).toBeUndefined();
  });

  it('returns name, message and stack for a plain Error', () => {
    const out = redactErrorForLog(new TypeError('nope'));
    expect(out).toMatchObject({ name: 'TypeError', message: 'nope' });
    expect(out.stack).toContain('nope');
  });

  it('never echoes a thrown object, only its type', () => {
    expect(redactErrorForLog({ config: { headers: { Authorization: TOKEN } } })).toEqual({
      name: 'object',
      message: '',
    });
    expect(redactErrorForLog('plain string')).toEqual({ name: 'string', message: 'plain string' });
  });
});
