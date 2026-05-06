import { describe, it, expect } from 'vitest';
import { AxiosError } from 'axios';
import { queryClient } from './queryClient';

describe('queryClient — retry policy', () => {
  // Pull the configured retry function back out of the QueryClient so we can
  // exercise its branches without a network round-trip.
  const opts = queryClient.getDefaultOptions().queries!;
  const retry = opts.retry as (failureCount: number, error: unknown) => boolean;

  it('does NOT retry a 401 response (interceptor handles refresh)', () => {
    const error = new AxiosError('unauthorized', undefined, undefined, undefined, {
      status: 401,
      statusText: 'Unauthorized',
      data: null,
      headers: {},
      config: {} as never,
    });
    expect(retry(0, error)).toBe(false);
  });

  it('retries once for non-401 axios errors', () => {
    const error = new AxiosError('server error', undefined, undefined, undefined, {
      status: 500,
      statusText: 'Internal Server Error',
      data: null,
      headers: {},
      config: {} as never,
    });
    expect(retry(0, error)).toBe(true);
    expect(retry(1, error)).toBe(false);
  });

  it('retries once for non-axios errors too', () => {
    const error = new Error('boom');
    expect(retry(0, error)).toBe(true);
    expect(retry(1, error)).toBe(false);
  });
});
