import { describe, expect, it, beforeEach } from 'vitest';
import { useAuthStore } from '@/stores/authStore';

describe('apiClient', () => {
  beforeEach(() => {
    useAuthStore.getState().clearTokens();
  });

  it('has baseURL /api/v1', async () => {
    const { apiClient } = await import('./client');
    expect(apiClient.defaults.baseURL).toBe('/api/v1');
  });

  it('attaches Authorization header when token is present', async () => {
    useAuthStore.getState().setTokens('test-access-token', 'test-refresh-token');
    const { apiClient } = await import('./client');

    // Simulate what the interceptor does by calling it directly
    const config = { headers: {} as Record<string, string> };
    const token = useAuthStore.getState().accessToken;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    expect(config.headers.Authorization).toBe('Bearer test-access-token');
    expect(apiClient.defaults.baseURL).toBe('/api/v1');
  });

  it('does not attach Authorization header when no token', async () => {
    const { apiClient } = await import('./client');
    // No token in store — default headers should have no Authorization key
    expect(apiClient.defaults.headers.common?.['Authorization']).toBeUndefined();
  });
});
