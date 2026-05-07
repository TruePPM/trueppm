import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/authStore';

export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * Mark the session as expired and notify listeners.
 *
 * Single helper so every 401-recovery failure path clears tokens, flips the
 * `sessionExpired` store flag, and dispatches the legacy DOM event in one
 * step. The store flag drives the SessionExpiredBanner render; the event
 * survives for tests / non-React code that listens for it.
 */
function expireSession(): void {
  useAuthStore.getState().markSessionExpired();
  window.dispatchEvent(new CustomEvent('auth:sessionExpired'));
}

// Attach JWT access token to every request — and short-circuit when the
// session has already been marked expired so queued mutations don't burn
// retry budget bouncing through the 401 → refresh → fail → expire loop (#352).
apiClient.interceptors.request.use((config) => {
  const { accessToken, sessionExpired } = useAuthStore.getState();
  if (sessionExpired) {
    // Synchronous abort: surface as a generic error to the caller's onError.
    return Promise.reject(new Error('Session expired'));
  }
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// Track whether a token refresh is already in-flight to prevent concurrent retries.
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const { refreshToken, setTokens } = useAuthStore.getState();

  if (!refreshToken) {
    expireSession();
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
      expireSession();
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
      expireSession();
      return Promise.reject(new Error('Session expired'));
    }
  },
);
