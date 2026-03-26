import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/authStore';

export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach JWT access token to every request
apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Track whether a token refresh is already in-flight to prevent concurrent retries.
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const { refreshToken, setTokens, clearTokens } = useAuthStore.getState();

  if (!refreshToken) {
    clearTokens();
    window.dispatchEvent(new CustomEvent('auth:sessionExpired'));
    throw new Error('No refresh token available');
  }

  const response = await axios.post<{ access: string }>(
    '/api/v1/auth/token/refresh/',
    { refresh: refreshToken },
  );

  const newAccessToken = response.data.access;
  // refreshToken is unchanged — we only receive a new access token
  setTokens(newAccessToken, refreshToken);
  return newAccessToken;
}

// 401 interceptor with single-flight token refresh and original request retry
apiClient.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!axios.isAxiosError(error) || error.response?.status !== 401) {
      const err = error instanceof Error ? error : new Error(String(error));
      return Promise.reject(err);
    }

    const originalRequest = error.config as AxiosRequestConfig & { _retried?: boolean };

    // Prevent infinite retry loops
    if (originalRequest._retried) {
      useAuthStore.getState().clearTokens();
      window.dispatchEvent(new CustomEvent('auth:sessionExpired'));
      return Promise.reject(new Error('Session expired'));
    }

    originalRequest._retried = true;

    try {
      // Coalesce concurrent 401s onto a single refresh attempt
      if (!refreshPromise) {
        refreshPromise = refreshAccessToken().finally(() => {
          refreshPromise = null;
        });
      }

      const newAccessToken = await refreshPromise;

      // Inject the new token into the retried request
      if (!originalRequest.headers) {
        originalRequest.headers = {};
      }
      (originalRequest.headers as Record<string, string>)['Authorization'] =
        `Bearer ${newAccessToken}`;

      return await apiClient(originalRequest);
    } catch {
      useAuthStore.getState().clearTokens();
      window.dispatchEvent(new CustomEvent('auth:sessionExpired'));
      return Promise.reject(new Error('Session expired'));
    }
  },
);
