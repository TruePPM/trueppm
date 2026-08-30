import { describe, expect, it } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { commitRefusalMessage } from './commitRefusal';

/**
 * Build an AxiosError the way `axios.isAxiosError` will actually recognize it.
 *
 * A plain object literal with a `response` key is NOT enough — `isAxiosError`
 * checks `isAxiosError === true` on the instance, so a hand-rolled fake makes
 * every one of these tests pass vacuously by falling through the first guard.
 */
function axiosError(status: number, data: unknown): AxiosError {
  const err = new AxiosError('boom', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

describe('commitRefusalMessage', () => {
  it('returns the server sentence for a 409 already_committed', () => {
    const err = axiosError(409, {
      detail: 'This plan has already been committed.',
      code: 'already_committed',
    });
    expect(commitRefusalMessage(err)).toBe('This plan has already been committed.');
  });

  it('returns null for a 409 carrying a different code', () => {
    // The generic retry copy IS right for other conflicts; only `already_committed`
    // is the one retrying can never clear.
    const err = axiosError(409, { detail: 'Row was moved.', code: 'wbs_path_occupied' });
    expect(commitRefusalMessage(err)).toBeNull();
  });

  it('returns null for a non-409 status even with the right code', () => {
    expect(commitRefusalMessage(axiosError(500, { code: 'already_committed' }))).toBeNull();
    expect(commitRefusalMessage(axiosError(403, { code: 'already_committed' }))).toBeNull();
  });

  it('returns null when the 409 body carries no usable detail string', () => {
    // Guards the shape, not just the code: a non-string `detail` must not reach
    // `toast.error` as "[object Object]".
    expect(commitRefusalMessage(axiosError(409, { code: 'already_committed' }))).toBeNull();
    expect(
      commitRefusalMessage(axiosError(409, { code: 'already_committed', detail: { a: 1 } })),
    ).toBeNull();
  });

  it('returns null for a non-axios error', () => {
    expect(commitRefusalMessage(new Error('offline'))).toBeNull();
    expect(commitRefusalMessage(null)).toBeNull();
    expect(commitRefusalMessage(undefined)).toBeNull();
  });
});
