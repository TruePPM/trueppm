import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { clearSessionCache, useAuthStore } from '@/stores/authStore';
// Imported from the module, not the barrel: the barrel also exports `ToastHost`, and
// pulling a React component into the API client's module graph is a cycle waiting to
// happen.
import { toast } from '@/components/Toast/toast';
import { subscribeAuthMessages } from '@/lib/authBroadcast';
import { queryClient } from '@/lib/queryClient';
import { isSameUser } from '@/lib/userId';
import type { CurrentUser } from '@/hooks/useCurrentUser';
import { DEMO_REFUSAL_TOAST, isDemoReadOnlyRefusal } from '@/lib/demoReadOnly';
import { isDemoReadOnlySync } from '@/hooks/useDemoMode';

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * Set by a caller that renders the read-only demo's refusal on a surface of its
     * own (ADR-1197 D3) — today only the Schedule commit popover, which is already
     * anchored at the moved bar. The global toast below stands down for it so the
     * visitor is not told the same thing twice in two places.
     */
    demoRefusalHandled?: boolean;
  }
}

export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
  // Bound every request so a stalled response (proxy black-hole, half-open
  // connection — plausible on the flaky networks this product targets) surfaces
  // as an error instead of an infinite `role="status"` skeleton (#2051). A
  // timeout becomes an Axios error → a TanStack Query error → the existing
  // QueryErrorState retry, rather than a spinner that never resolves. Long,
  // user-initiated import/export and file-upload calls opt out per-request with
  // an inline `timeout: 0` in their config — a large MSP import, an export
  // bundle download, or an attachment upload legitimately exceeds this, and a
  // hang there is already visible via that flow's own progress affordance.
  timeout: 30_000,
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
 *
 * `confirmed` says the server itself refused the session (a 401), as opposed to a
 * refresh that failed on a network error, a timeout or a 5xx. Only a confirmed
 * refusal is told to sibling tabs (#4296): they share the refresh cookie, so a
 * real refusal is theirs too, but a server blip seen here says nothing about the
 * cookie and must not sign out every healthy tab of the origin. This tab's own
 * behavior is the same either way.
 */
function expireSession(confirmed: boolean): void {
  useAuthStore.getState().markSessionExpired({ broadcast: confirmed });
  window.dispatchEvent(new CustomEvent('auth:sessionExpired'));
}

/** The server answered 401: the session itself was refused, not merely unreachable. */
function isConfirmedRefusal(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 401;
}

// Attach JWT access token to every request — and short-circuit when the
// session has already been marked expired so queued mutations don't burn
// retry budget bouncing through the 401 → refresh → fail → expire loop (#352).
apiClient.interceptors.request.use((config) => {
  const { accessToken, sessionExpired } = useAuthStore.getState();
  if (sessionExpired) {
    // Synchronous abort: surface as a generic, cause-agnostic error to the
    // caller's onError — this message reaches SyncStatusModal's "Last error"
    // text verbatim (via useSyncStatus/readError), so it must not claim
    // "expired" any more than the banner copy does (#4256).
    return Promise.reject(new Error('Signed out'));
  }
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// Track whether a token refresh is already in-flight to prevent concurrent retries.
let refreshPromise: Promise<string> | null = null;

/** Web Lock name that serializes cookie refreshes across every tab of this origin. */
export const REFRESH_LOCK_NAME = 'trueppm-auth-refresh';

/**
 * How long to wait before the single retry of a refused refresh. Long enough for a
 * sibling tab's in-flight rotation response (and its `Set-Cookie`) to land.
 */
export const REFRESH_RETRY_DELAY_MS = 300;

const REFRESH_TIMEOUT_MS = 30_000;

function postCookieRefresh() {
  // The refresh token lives in an httpOnly cookie (#897), not in the store or
  // the request body. `withCredentials` sends that cookie; the server reads it,
  // rotates it (sets a fresh cookie), and returns only a new access token. We
  // never see or send the refresh token from JavaScript.
  //
  // Bounded like every apiClient call: this request runs while holding the
  // cross-tab refresh lock, so a hung response would otherwise stall the refresh
  // of every tab of the origin, not just this one.
  return axios.post<{ access: string }>(
    '/api/v1/auth/token/refresh/',
    {},
    { withCredentials: true, timeout: REFRESH_TIMEOUT_MS },
  );
}

/**
 * One cookie refresh, tolerant of a sibling tab having just rotated the cookie.
 *
 * Every tab shares ONE refresh cookie, and the server rotates it and blacklists
 * the value it consumed (ROTATE_REFRESH_TOKENS + BLACKLIST_AFTER_ROTATION). A tab
 * whose request carries the value a sibling has just rotated is refused with 401
 * even though the session is alive — that refusal surfaced as a false "Your
 * session expired" on reload (#4247). The retry re-sends with whatever the jar now
 * holds, which is the sibling's rotated value. Only a 401 is retried, and only
 * once: a genuinely dead session (logout, revocation, TTL) is refused again and
 * still expires. No server-side grace for the consumed token is needed, so the
 * #2999 revocation guarantee is untouched.
 */
async function postCookieRefreshWithSiblingRetry() {
  try {
    return await postCookieRefresh();
  } catch (error: unknown) {
    if (!axios.isAxiosError(error) || error.response?.status !== 401) throw error;
    await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS));
    return postCookieRefresh();
  }
}

/**
 * Run `fn` while holding the cross-tab refresh lock, when the browser has one.
 *
 * `refreshPromise` only coalesces refreshes within ONE tab. The Web Lock extends
 * that to every tab of the origin: a reloading tab waits for a sibling's in-flight
 * rotation to finish (its response, and therefore its `Set-Cookie`, has landed by
 * the time the lock is released) and then refreshes with the rotated cookie,
 * instead of racing it with the stale one (#4247). Browsers without the Locks API
 * fall back to the retry in `postCookieRefreshWithSiblingRetry`.
 */
function withCrossTabRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  // The DOM lib types `navigator.locks` as always present; it is not (jsdom, older
  // embedded WebViews), so this check is load-bearing at runtime.
  const locks: LockManager | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return fn();
  return requestRefreshLock(locks, fn);
}

/** Wait on a sibling's refresh this long before saying so in the status bar (#4296). */
export const LOCK_STALL_NOTICE_MS = 1_000;

/**
 * Give up waiting for the lock after this long and refresh anyway (#4296). A hung
 * refresh in one tab holds the lock for up to `REFRESH_TIMEOUT_MS`, and every other
 * tab used to sit silent behind it for that whole time. Shorter than the hold, so a
 * waiter always outlives the stall. The worst case of falling through is the race
 * the lock exists to prevent, which `postCookieRefreshWithSiblingRetry` already absorbs.
 */
export const LOCK_WAIT_MS = 6_000;

async function requestRefreshLock<T>(locks: LockManager, fn: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let acquired = false;
  const setWaiting = useAuthStore.getState().setWaitingOnSiblingTab;
  const noticeTimer = setTimeout(() => setWaiting(true), LOCK_STALL_NOTICE_MS);
  const giveUpTimer = setTimeout(() => controller.abort(), LOCK_WAIT_MS);
  try {
    return await (locks.request(REFRESH_LOCK_NAME, { signal: controller.signal }, () => {
      acquired = true;
      clearTimeout(noticeTimer);
      clearTimeout(giveUpTimer);
      setWaiting(false);
      return fn();
    }) as Promise<T>);
  } catch (error: unknown) {
    // Only an abort of the WAIT falls through; an error from `fn` itself propagates.
    if (!acquired && error instanceof DOMException && error.name === 'AbortError') {
      setWaiting(false);
      return fn();
    }
    throw error;
  } finally {
    clearTimeout(noticeTimer);
    clearTimeout(giveUpTimer);
    setWaiting(false);
  }
}

async function refreshAccessToken(): Promise<string> {
  const response = await withCrossTabRefreshLock(postCookieRefreshWithSiblingRetry);
  const newAccessToken = response.data.access;
  useAuthStore.getState().setAccessToken(newAccessToken);
  return newAccessToken;
}

/**
 * Re-mint this tab's token after a sibling tab signed in (#4296).
 *
 * The sibling may have signed in as a DIFFERENT user, and this tab's cache still
 * holds the previous user's reads. So before the token is stored (which lifts the
 * expired state and puts the cache back on screen as live), ask `/auth/me/` with
 * the new token who it belongs to, and clear the cache unless it is provably the
 * same user. A failed or impossible identity check counts as "changed": clearing costs a refetch,
 * keeping the wrong user's data costs a disclosure. Plain `axios`, not `apiClient`:
 * the latter refuses every request while `sessionExpired` is still true.
 */
async function adoptSiblingSession(): Promise<string> {
  const previous = queryClient.getQueryData<CurrentUser>(['current-user']);
  const response = await withCrossTabRefreshLock(postCookieRefreshWithSiblingRetry);
  const token = response.data.access;
  // No cached identity to compare against (the shell's `/auth/me/` read never
  // landed) proves nothing either way, so it is treated as a change too.
  let sameUser = false;
  if (previous) {
    try {
      const me = await axios.get<CurrentUser>('/api/v1/auth/me/', {
        headers: { Authorization: `Bearer ${token}` },
        timeout: REFRESH_TIMEOUT_MS,
      });
      sameUser = isSameUser(me.data.id, previous.id);
    } catch {
      sameUser = false;
    }
  }
  if (!sameUser) queryClient.clear();
  // The sibling already announced the sign-in; do not echo it back.
  useAuthStore.getState().setAccessToken(token, { broadcast: false });
  return token;
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
    refreshPromise ??= refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
    await refreshPromise;
    return true;
  } catch (error: unknown) {
    expireSession(isConfirmedRefusal(error));
    return false;
  }
}

// 401 interceptor with single-flight token refresh and original request retry
apiClient.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    // The read-only demo's refusal is a designed surface, not an error (ADR-1197 D3):
    // an `info` toast, never the red one, and only for writes that have no anchored
    // affordance of their own. The rejection still propagates below — every downstream
    // `onError` (the preview overlay's write included) depends on it.
    // Gated on BOTH facts, like the overlay write in `useTaskMutations`: the code is
    // the server's word for this refusal, and `isDemoReadOnlySync()` is what says this
    // deployment is actually the demo. Without the second, any future 403 carrying
    // that code on a real install would tell the user their change "wasn't saved
    // because this is a read-only demo" when it was refused for a real reason — D3's
    // failure mode, inverted.
    if (
      isDemoReadOnlyRefusal(error) &&
      isDemoReadOnlySync() &&
      error.config?.demoRefusalHandled !== true
    ) {
      toast.info(DEMO_REFUSAL_TOAST);
    }
    if (!axios.isAxiosError(error) || error.response?.status !== 401) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw err;
    }

    const originalRequest = error.config as AxiosRequestConfig & { _retried?: boolean };

    // Prevent infinite retry loops
    if (originalRequest._retried) {
      // A freshly minted token was refused: the server's own answer.
      expireSession(true);
      throw new Error('Signed out');
    }

    originalRequest._retried = true;

    try {
      // Coalesce concurrent 401s onto a single refresh attempt
      refreshPromise ??= refreshAccessToken().finally(() => {
        refreshPromise = null;
      });

      const newAccessToken = await refreshPromise;

      // Inject the new token into the retried request
      originalRequest.headers ??= {};
      (originalRequest.headers as Record<string, string>)['Authorization'] =
        `Bearer ${newAccessToken}`;

      return await apiClient(originalRequest);
    } catch (retryError: unknown) {
      expireSession(isConfirmedRefusal(retryError));
      throw new Error('Signed out');
    }
  },
);

/**
 * Mirror session changes made in a sibling tab (#4296). Messages carry no token: a
 * restored tab re-mints its own from the shared refresh cookie. Each branch only
 * acts when this tab is in a state the message changes, which also ends any
 * ping-pong between tabs.
 */
subscribeAuthMessages((type) => {
  const state = useAuthStore.getState();
  switch (type) {
    case 'expired':
      // A tab sitting on /login holds no session to lose.
      if (state.isAuthenticated && !state.sessionExpired)
        state.markSessionExpired({ broadcast: false });
      break;
    case 'readonly':
      // Honor the choice only where this tab has content to keep viewing.
      if (state.sessionExpired && state.sessionExpiredCanView)
        state.enterReadOnlyMode({ broadcast: false });
      break;
    case 'cleared':
      // Same as this tab's own menu sign-out: the tokens AND the previous user's
      // cached reads go, so nothing of theirs stays in this tab's memory.
      if (state.isAuthenticated || state.sessionExpired) {
        state.clearTokens({ broadcast: false });
        clearSessionCache();
      }
      break;
    case 'restored':
      if (state.sessionExpired) {
        // Failure leaves this tab expired: its own Sign in is still there, and a
        // failed attempt here must not re-expire the tab that just signed in.
        refreshPromise ??= adoptSiblingSession().finally(() => {
          refreshPromise = null;
        });
        void refreshPromise.catch(() => undefined);
      }
      break;
  }
});
