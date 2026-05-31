import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/authStore';

export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
  // Send the httpOnly refresh cookie on same-origin requests so the refresh
  // endpoint receives it (#897). The cookie is Path-scoped to the refresh
  // endpoint, so it is only actually attached to refresh requests.
  withCredentials: true,
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
  const { setAccessToken } = useAuthStore.getState();

  // The refresh token lives in an httpOnly cookie (#897), not in the store or
  // the request body. `withCredentials` sends that cookie; the server reads it,
  // rotates it (sets a fresh cookie), and returns only a new access token. We
  // never see or send the refresh token from JavaScript.
  const response = await axios.post<{ access: string }>(
    '/api/v1/auth/token/refresh/',
    {},
    { withCredentials: true },
  );

  const newAccessToken = response.data.access;
  setAccessToken(newAccessToken);
  return newAccessToken;
}

/**
 * Mint an access token from the httpOnly refresh cookie on app bootstrap.
 *
 * Since #897 the access token is in memory only, so on a fresh page load,
 * reload, or deep-link it starts null even when `isAuthenticated` is true (the
 * persisted hint). Without this, the first wave of data queries would all fire
 * unauthenticated, take a 401, and recover only via the reactive per-request
 * refresh-retry — a 401 storm that also thrashes the WebSocket as the token
 * flips null→fresh, and that does not reliably hydrate a page within a normal
 * timeout (#911). Calling this once before the protected app renders restores
 * the pre-#897 invariant that a valid token is present after hydration.
 *
 * Shares the single-flight `refreshPromise` with the 401 interceptor so a
 * concurrent reactive refresh and this bootstrap refresh coalesce into one
 * network call. Returns true on success; on failure marks the session expired
 * (mirroring the interceptor's terminal path) and returns false.
 */
export async function bootstrapAccessToken(): Promise<boolean> {
  try {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken().finally(() => {
        refreshPromise = null;
      });
    }
    await refreshPromise;
    return true;
  } catch {
    expireSession();
    return false;
  }
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
