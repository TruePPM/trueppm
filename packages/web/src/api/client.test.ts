import { describe, expect, it, beforeEach } from 'vitest';
import { type InternalAxiosRequestConfig } from 'axios';
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
  const handlers = (client.interceptors.request as unknown as {
    handlers: Array<{ fulfilled: (c: InternalAxiosRequestConfig) => InternalAxiosRequestConfig }>;
  }).handlers;
  return handlers[index].fulfilled;
}

// Helper to extract the N-th registered response interceptor's handlers.
function getResponseInterceptors(
  client: Awaited<ReturnType<typeof getApiClient>>,
  index = 0,
) {
  const handlers = (client.interceptors.response as unknown as {
    handlers: Array<{
      fulfilled: (r: unknown) => unknown;
      rejected: (e: unknown) => Promise<never>;
    }>;
  }).handlers;
  return handlers[index];
}

describe('apiClient', () => {
  beforeEach(() => {
    useAuthStore.getState().clearTokens();
  });

  it('has baseURL /api/v1', async () => {
    const client = await getApiClient();
    expect(client.defaults.baseURL).toBe('/api/v1');
  });

  describe('request interceptor', () => {
    it('attaches Authorization header when a token is present in the store', async () => {
      useAuthStore.getState().setTokens('test-access-token', 'test-refresh-token');
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
      useAuthStore.getState().setTokens('access', 'refresh');
      const client = await getApiClient();
      const { rejected } = getResponseInterceptors(client);

      // config is required — the new interceptor reads _retried and headers from it.
      // The refresh attempt will fail (no network in tests) → the catch block calls
      // clearTokens() and re-throws 'Session expired'.
      const axiosError = Object.assign(new Error('Unauthorized'), {
        isAxiosError: true,
        response: { status: 401 },
        config: { headers: {} },
      });
      await expect(rejected(axiosError)).rejects.toThrow('Session expired');
      expect(useAuthStore.getState().accessToken).toBeNull();
    });

    it('does not clear tokens for non-401 errors', async () => {
      useAuthStore.getState().setTokens('access', 'refresh');
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
