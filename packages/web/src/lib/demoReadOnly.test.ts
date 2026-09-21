import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import type { AxiosResponse } from 'axios';
import { isDemoReadOnlyRefusal, DEMO_READ_ONLY_CODE } from './demoReadOnly';

function axiosErrorWith(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  const response = { status, data, statusText: '', headers: {}, config } as AxiosResponse;
  return new AxiosError('refused', 'ERR_BAD_REQUEST', config, {}, response);
}

describe('isDemoReadOnlyRefusal', () => {
  it('matches a 403 carrying the demo code', () => {
    expect(
      isDemoReadOnlyRefusal(axiosErrorWith(403, { detail: 'x', code: DEMO_READ_ONLY_CODE })),
    ).toBe(true);
  });

  it('rejects an ordinary RBAC 403 with no code', () => {
    // The whole point of the code check: telling a user with genuinely insufficient
    // rights that "nothing here is saved" is the failure D3 exists to prevent, inverted.
    expect(isDemoReadOnlyRefusal(axiosErrorWith(403, { detail: 'Not permitted.' }))).toBe(false);
  });

  it('rejects a 400 whose body happens to carry the code', () => {
    expect(isDemoReadOnlyRefusal(axiosErrorWith(400, { code: DEMO_READ_ONLY_CODE }))).toBe(false);
  });

  it('rejects a network error with no response at all', () => {
    expect(isDemoReadOnlyRefusal(new AxiosError('Network Error', 'ERR_NETWORK'))).toBe(false);
  });

  it('rejects a 403 whose body is an HTML string', () => {
    // A genuine crash never reaches DRF's JSON renderer; axios hands the whole Django
    // error page over as a string, and `typeof 'x' === 'object'` is false.
    expect(isDemoReadOnlyRefusal(axiosErrorWith(403, '<html>500</html>'))).toBe(false);
  });

  it('rejects a non-axios value', () => {
    expect(isDemoReadOnlyRefusal(new Error('boom'))).toBe(false);
    expect(isDemoReadOnlyRefusal(null)).toBe(false);
  });
});
