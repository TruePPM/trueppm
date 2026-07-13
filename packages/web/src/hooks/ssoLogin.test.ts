import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { discoverSso, SSO_LOGIN_PATH } from './ssoLogin';

// discoverSso deliberately depends only on bare `axios` (never `apiClient`) so
// the login screen stays a leaf that does not pull in the 401→refresh
// interceptor (ADR-0187, #1392). Mock bare axios, the same way LoginPage.test
// does, to prove that contract holds.
vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('discoverSso', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hits GET /api/v1/auth/oidc/discover/ with the email as a param, via bare axios', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { provider_present: true, display_name: 'Acme SSO', issuer: 'https://id.acme.io' },
    });

    const result = await discoverSso('user@acme.io');

    // eslint-disable-next-line @typescript-eslint/unbound-method -- mockedAxios.get is a vi.mocked mock, not a bound method
    expect(mockedAxios.get).toHaveBeenCalledWith('/api/v1/auth/oidc/discover/', {
      params: { email: 'user@acme.io' },
    });
    expect(result).toEqual({
      provider_present: true,
      display_name: 'Acme SSO',
      issuer: 'https://id.acme.io',
    });
  });

  it('returns the server payload unchanged when no provider serves the domain', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { provider_present: false } });

    const result = await discoverSso('user@nowhere.example');

    expect(result).toEqual({ provider_present: false });
  });

  it('ALWAYS resolves — a network error degrades to { provider_present: false }', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

    // The promise must not reject; the login screen falls back to password entry
    // rather than surfacing an error the user cannot act on.
    await expect(discoverSso('user@acme.io')).resolves.toEqual({ provider_present: false });
  });

  it('degrades to { provider_present: false } on a non-network rejection too', async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 500 } });

    await expect(discoverSso('user@acme.io')).resolves.toEqual({ provider_present: false });
  });

  it('exposes the unauthenticated RP login path as a stable constant', () => {
    expect(SSO_LOGIN_PATH).toBe('/api/v1/auth/oidc/login');
  });
});
