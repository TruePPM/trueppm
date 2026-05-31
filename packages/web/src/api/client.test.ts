import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/authStore';

// Re-import every time so each test gets the module-level interceptors registered
// by client.ts. Module caching means the same apiClient instance is reused within
// a single test file, which is fine — interceptors are registered once on import.
async function getApiClient() {
  const mod = await import('./client');
  return mod.apiClient;
}

// Helper to extract the N-th registered request interceptor's fulfilled handler.
function getRequestInterceptor(client: Awaited<ReturnType<typeof getApiClient>>, index = 0) {
  // axios v1.x stores handlers as an array on InterceptorManager
  const handlers = (
    client.interceptors.request as unknown as {
      handlers: Array<{ fulfilled: (c: InternalAxiosRequestConfig) => InternalAxiosRequestConfig }>;
    }
  ).handlers;
  return handlers[index].fulfilled;
}

// Helper to extract the N-th registered response interceptor's handlers.
function getResponseInterceptors(client: Awaited<ReturnType<typeof getApiClient>>, index = 0) {
  const handlers = (
    client.interceptors.response as unknown as {
      handlers: Array<{
        fulfilled: (r: unknown) => unknown;
        rejected: (e: unknown) => Promise<never>;
      }>;
    }
  ).handlers;
  return handlers[index];
}

describe('apiClient', () => {
  beforeEach(() => {
    useAuthStore.getState().clearTokens();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has baseURL /api/v1', async () => {
    const client = await getApiClient();
    expect(client.defaults.baseURL).toBe('/api/v1');
  });

  it('sends credentials so the httpOnly refresh cookie is attached (#897)', async () => {
    const client = await getApiClient();
    expect(client.defaults.withCredentials).toBe(true);
  });

  describe('request interceptor', () => {
    it('attaches Authorization header when a token is present in the store', async () => {
      useAuthStore.getState().setAccessToken('test-access-token');
      const client = await getApiClient();
      const interceptor = getRequestInterceptor(client);
      const config = { headers: {} } as InternalAxiosRequestConfig;
      const result = interceptor(config);
      expect((result.headers as Record<string, string>).Authorization).toBe(
        'Bearer test-access-token',
      );
    });

    it('does not attach Authorization header when the store has no token', async () => {
      const client = await getApiClient();
      const interceptor = getRequestInterceptor(client);
      const config = { headers: {} } as InternalAxiosRequestConfig;
      const result = interceptor(config);
      expect((result.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    it('returns the config object unchanged (besides the header)', async () => {
      const client = await getApiClient();
      const interceptor = getRequestInterceptor(client);
      const config = { headers: { 'X-Custom': 'value' } } as unknown as InternalAxiosRequestConfig;
      const result = interceptor(config);
      expect(result).toBe(config);
    });
  });

  describe('response interceptor', () => {
    it('passes successful responses through unmodified', async () => {
      const client = await getApiClient();
      const { fulfilled } = getResponseInterceptors(client);
      const fakeResponse = { status: 200, data: { ok: true } };
      expect(fulfilled(fakeResponse)).toBe(fakeResponse);
    });

    it('clears auth tokens after a failed token refresh on 401', async () => {
      useAuthStore.getState().setAccessToken('access');
      const client = await getApiClient();
      const { rejected } = getResponseInterceptors(client);

      // config is required — the interceptor reads _retried and headers from it.
      // The refresh attempt will fail (no network in tests) → the catch block calls
      // expireSession() and re-throws 'Session expired'.
      const axiosError = Object.assign(new Error('Unauthorized'), {
        isAxiosError: true,
        response: { status: 401 },
        config: { headers: {} },
      });
      await expect(rejected(axiosError)).rejects.toThrow('Session expired');
      expect(useAuthStore.getState().accessToken).toBeNull();
    });

    // #897: on a 401 the interceptor must refresh via the httpOnly cookie — it
    // posts an empty body with credentials:include and reads the new access
    // token out of the response. No refresh token is sent or received in JS.
    it('refreshes via the cookie endpoint and stores the new access token', async () => {
      useAuthStore.getState().setAccessToken('stale-access');
      const client = await getApiClient();
      const { rejected } = getResponseInterceptors(client);

      const postSpy = vi
        .spyOn(axios, 'post')
        .mockResolvedValueOnce({ data: { access: 'fresh-access' } });
      // The retry is dispatched via `apiClient(originalRequest)`, which calls the
      // bound `Axios.prototype.request` — NOT the instance's `request` property —
      // so spying `client.request` would not intercept it. Stub the adapter, the
      // real seam through which the retried request flows, to capture it without a
      // network call.
      const originalAdapter = client.defaults.adapter;
      const adapterSpy = vi
        .fn()
        .mockResolvedValue({ status: 200, data: { ok: true }, headers: {}, config: {} });
      client.defaults.adapter = adapterSpy;

      const axiosError = Object.assign(new Error('Unauthorized'), {
        isAxiosError: true,
        response: { status: 401 },
        config: { headers: {} },
      });

      try {
        await rejected(axiosError);

        // Refresh call: empty body, credentials included, no refresh token in body.
        expect(postSpy).toHaveBeenCalledWith(
          '/api/v1/auth/token/refresh/',
          {},
          { withCredentials: true },
        );
        const [, body] = postSpy.mock.calls[0];
        expect(body).toEqual({});
        // New access token stored in memory; original request retried with it.
        expect(useAuthStore.getState().accessToken).toBe('fresh-access');
        expect(adapterSpy).toHaveBeenCalled();
        // The retried request carries the fresh bearer token.
        const retryConfig = adapterSpy.mock.calls[0][0] as { headers?: Record<string, string> };
        expect(retryConfig.headers?.Authorization).toBe('Bearer fresh-access');
      } finally {
        client.defaults.adapter = originalAdapter;
      }
    });

    it('does not clear tokens for non-401 errors', async () => {
      useAuthStore.getState().setAccessToken('access');
      const client = await getApiClient();
      const { rejected } = getResponseInterceptors(client);

      const axiosError = Object.assign(new Error('Server Error'), {
        isAxiosError: true,
        response: { status: 500 },
      });
      await expect(rejected(axiosError)).rejects.toThrow('Server Error');
      expect(useAuthStore.getState().accessToken).toBe('access');
    });

    it('wraps a non-Error rejection in an Error before re-throwing', async () => {
      const client = await getApiClient();
      const { rejected } = getResponseInterceptors(client);
      await expect(rejected('plain string error')).rejects.toBeInstanceOf(Error);
    });

    it('re-throws an existing Error instance directly', async () => {
      const client = await getApiClient();
      const { rejected } = getResponseInterceptors(client);
      const original = new Error('network failure');
      // axios.isAxiosError returns false for plain Errors
      await expect(rejected(original)).rejects.toThrow('network failure');
    });
  });
});
