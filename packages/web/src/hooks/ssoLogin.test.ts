import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { discoverSsoProviders, ssoLoginUrl, SSO_LOGIN_PATH } from './ssoLogin';

// discoverSsoProviders deliberately depends only on bare `axios` (never
// `apiClient`) so the login screen stays a leaf that does not pull in the
// 401→refresh interceptor (ADR-0517, #2108). Mock bare axios, the same way
// LoginPage.test does, to prove that contract holds.
vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('discoverSsoProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GETs /auth/oidc/discover/ with no params when no email is given', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        provider_present: true,
        providers: [
          { slug: 'keycloak', display_name: 'Keycloak' },
          { slug: 'github', display_name: 'GitHub' },
        ],
      },
    });

    const result = await discoverSsoProviders();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- mockedAxios.get is a vi.mocked mock, not a bound method
    expect(mockedAxios.get).toHaveBeenCalledWith('/api/v1/auth/oidc/discover/', undefined);
    expect(result.provider_present).toBe(true);
    expect(result.providers.map((p) => p.slug)).toEqual(['keycloak', 'github']);
  });

  it('passes the email as a param when given (domain-narrowed discovery)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { provider_present: true, providers: [{ slug: 'keycloak', display_name: 'Keycloak' }] },
    });

    await discoverSsoProviders('user@acme.io');

    // eslint-disable-next-line @typescript-eslint/unbound-method -- mockedAxios.get is a vi.mocked mock, not a bound method
    expect(mockedAxios.get).toHaveBeenCalledWith('/api/v1/auth/oidc/discover/', {
      params: { email: 'user@acme.io' },
    });
  });

  it('defaults providers to [] when the payload omits the list', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { provider_present: false } });

    const result = await discoverSsoProviders();

    expect(result).toEqual({ provider_present: false, providers: [] });
  });

  it('ALWAYS resolves — a network error degrades to an empty list', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

    await expect(discoverSsoProviders()).resolves.toEqual({
      provider_present: false,
      providers: [],
    });
  });

  it('degrades on a non-network rejection too', async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 500 } });

    await expect(discoverSsoProviders('user@acme.io')).resolves.toEqual({
      provider_present: false,
      providers: [],
    });
  });
});

describe('ssoLoginUrl', () => {
  it('builds a provider-scoped login URL, encoding the slug', () => {
    expect(ssoLoginUrl('keycloak')).toBe('/api/v1/auth/oidc/login?provider=keycloak');
    expect(ssoLoginUrl('openid connect')).toBe(
      '/api/v1/auth/oidc/login?provider=openid%20connect',
    );
  });

  it('exposes the unauthenticated RP login path as a stable constant', () => {
    expect(SSO_LOGIN_PATH).toBe('/api/v1/auth/oidc/login');
  });
});
