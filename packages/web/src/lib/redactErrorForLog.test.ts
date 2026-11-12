import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logRouterError, redactedRootErrorOptions, redactErrorForLog } from './redactErrorForLog';

const TOKEN = 'Bearer secret-access-token-123';

function makeAxiosError(url: string, status?: number): AxiosError {
  const config = {
    method: 'get',
    url,
    headers: new AxiosHeaders({ Authorization: TOKEN }),
    data: '{"password":"hunter2"}',
  } as InternalAxiosRequestConfig;
  const response =
    status === undefined ? undefined : { status, statusText: '', data: {}, headers: {}, config };
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

  it('tolerates an AxiosError with no config, and null/undefined', () => {
    const bare = new AxiosError('Network Error', 'ERR_NETWORK');
    expect(redactErrorForLog(bare)).toMatchObject({ name: 'AxiosError', code: 'ERR_NETWORK' });
    expect(redactErrorForLog(null)).toEqual({ name: 'object', message: '' });
    expect(redactErrorForLog(undefined)).toEqual({ name: 'undefined', message: '' });
  });
});

describe('thrown Response / route errors', () => {
  it('keeps numeric status and statusText, nothing else', () => {
    const routeError = { status: 404, statusText: 'Not Found', data: 'secret body', headers: { a: 'b' } };
    expect(redactErrorForLog(routeError)).toEqual({
      name: 'object',
      message: '',
      status: 404,
      statusText: 'Not Found',
    });
    expect(redactErrorForLog({ status: 500 })).toEqual({ name: 'object', message: '', status: 500 });
  });

  it('ignores a non-numeric status', () => {
    expect(redactErrorForLog({ status: '404' })).toEqual({ name: 'object', message: '' });
  });

  it('logRouterError logs the status', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logRouterError({ status: 403, statusText: 'Forbidden' });
    expect(spy).toHaveBeenCalledWith(
      '[Router] caught an error:',
      expect.objectContaining({ status: 403, statusText: 'Forbidden' }),
    );
    spy.mockRestore();
  });
});

describe('redactedRootErrorOptions.onUncaughtError', () => {
  afterEach(() => vi.restoreAllMocks());

  it('re-dispatches a redacted ErrorEvent on window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: ErrorEvent[] = [];
    const listener = (e: Event) => seen.push(e as ErrorEvent);
    window.addEventListener('error', listener);
    try {
      const err = makeAxiosError('/api/v1/tasks/?token=abc', 500);
      redactedRootErrorOptions.onUncaughtError(err, { componentStack: '' });
    } finally {
      window.removeEventListener('error', listener);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe('Request failed');
    expect(JSON.stringify(seen[0].error.stack)).not.toContain('secret-access-token');
    expect(seen[0].error).not.toBeInstanceOf(AxiosError);
  });
});
