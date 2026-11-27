import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/components/Toast/toastStore';
import { queryClient } from '@/lib/queryClient';
import * as authBroadcast from '@/lib/authBroadcast';

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

  it('bounds every request with a 30s timeout so a hang surfaces as an error (#2051)', async () => {
    const client = await getApiClient();
    expect(client.defaults.timeout).toBe(30_000);
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
      // expireSession() and re-throws 'Signed out'.
      const axiosError = Object.assign(new Error('Unauthorized'), {
        isAxiosError: true,
        response: { status: 401 },
        config: { headers: {} },
      });
      await expect(rejected(axiosError)).rejects.toThrow('Signed out');
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
          { withCredentials: true, timeout: 30_000 },
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

  // #911: a fresh page load has no in-memory access token (#897), so the app
  // mints one from the httpOnly refresh cookie BEFORE rendering. This is the
  // same single-flight cookie refresh the 401 interceptor uses, exposed so the
  // route guard can pre-warm the token and avoid a 401 storm on every reload.
  describe('bootstrapAccessToken', () => {
    async function getBootstrap() {
      const mod = await import('./client');
      return mod.bootstrapAccessToken;
    }

    it('mints and stores an access token from the cookie endpoint, returning true', async () => {
      const bootstrapAccessToken = await getBootstrap();
      const postSpy = vi
        .spyOn(axios, 'post')
        .mockResolvedValueOnce({ data: { access: 'boot-access' } });

      await expect(bootstrapAccessToken()).resolves.toBe(true);

      expect(postSpy).toHaveBeenCalledWith(
        '/api/v1/auth/token/refresh/',
        {},
        { withCredentials: true, timeout: 30_000 },
      );
      expect(useAuthStore.getState().accessToken).toBe('boot-access');
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });

    // ADR-1523 §4: the installed app opened with no signal. The session was not
    // refused, it is unreachable, so the sign-in modal must not cover the offline shell.
    it('leaves the session alone when the refresh fails because the device is offline', async () => {
      const bootstrapAccessToken = await getBootstrap();
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      try {
        vi.spyOn(axios, 'post').mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK'));
        await expect(bootstrapAccessToken()).resolves.toBe(false);
        expect(useAuthStore.getState().sessionExpired).toBe(false);
      } finally {
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      }
    });

    // #4296: only the server's own refusal speaks for the shared cookie.
    it.each([
      [
        'a 5xx',
        new AxiosError('Bad Gateway', 'ERR_BAD_RESPONSE', undefined, undefined, {
          status: 502,
          data: {},
        } as AxiosResponse),
      ],
      ['a network error', new AxiosError('Network Error', 'ERR_NETWORK')],
      ['a timeout', new AxiosError('timeout', 'ECONNABORTED')],
    ])('expires this tab but tells no sibling on %s', async (_label, failure) => {
      const bootstrapAccessToken = await getBootstrap();
      const post = vi.spyOn(authBroadcast, 'postAuthMessage');
      vi.spyOn(axios, 'post').mockRejectedValue(failure);
      await expect(bootstrapAccessToken()).resolves.toBe(false);
      expect(useAuthStore.getState().sessionExpired).toBe(true);
      expect(post).not.toHaveBeenCalledWith('expired');
    });

    it('tells sibling tabs when the refresh endpoint refuses the session with a 401', async () => {
      const bootstrapAccessToken = await getBootstrap();
      const post = vi.spyOn(authBroadcast, 'postAuthMessage');
      const refused = new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 401,
        data: {},
      } as AxiosResponse);
      vi.spyOn(axios, 'post').mockRejectedValue(refused);
      await expect(bootstrapAccessToken()).resolves.toBe(false);
      expect(post).toHaveBeenCalledWith('expired');
    });

    it('marks the session expired and returns false when the cookie refresh fails', async () => {
      const bootstrapAccessToken = await getBootstrap();
      vi.spyOn(axios, 'post').mockRejectedValueOnce(new Error('no cookie'));

      await expect(bootstrapAccessToken()).resolves.toBe(false);

      expect(useAuthStore.getState().accessToken).toBeNull();
      expect(useAuthStore.getState().sessionExpired).toBe(true);
    });
  });

  // #4247: every tab shares ONE rotating refresh cookie. A reloading tab that
  // presents the value a sibling tab has just rotated is refused (401) by the
  // blacklist, which used to surface as a false "Your session expired".
  describe('concurrent-tab refresh (#4247)', () => {
    function refused401() {
      return new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 401,
        data: { detail: 'Token is blacklisted' },
      } as AxiosResponse);
    }

    async function getModule() {
      return import('./client');
    }

    /** A minimal origin-wide LockManager: one holder at a time, FIFO waiters. */
    function installFakeLocks() {
      let tail: Promise<unknown> = Promise.resolve();
      const requested: string[] = [];
      const locks = {
        request: (
          name: string,
          optsOrCb: LockOptions | (() => Promise<unknown>),
          maybeCb?: () => Promise<unknown>,
        ) => {
          requested.push(name);
          const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb)!;
          const run = tail.then(cb, cb);
          tail = run.catch(() => undefined);
          return run;
        },
      };
      Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
      return { locks, requested };
    }

    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(navigator, 'locks');
    });

    it('retries once with the rotated cookie when a sibling tab won the race', async () => {
      vi.useFakeTimers();
      const { bootstrapAccessToken, REFRESH_RETRY_DELAY_MS } = await getModule();
      const postSpy = vi
        .spyOn(axios, 'post')
        .mockRejectedValueOnce(refused401())
        .mockResolvedValueOnce({ data: { access: 'rotated-access' } });

      const pending = bootstrapAccessToken();
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);

      await expect(pending).resolves.toBe(true);
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().accessToken).toBe('rotated-access');
      expect(useAuthStore.getState().sessionExpired).toBe(false);
    });

    it('still expires a genuinely dead session, after exactly one retry', async () => {
      vi.useFakeTimers();
      const { bootstrapAccessToken, REFRESH_RETRY_DELAY_MS } = await getModule();
      const postSpy = vi
        .spyOn(axios, 'post')
        .mockRejectedValueOnce(refused401())
        .mockRejectedValueOnce(refused401());

      const pending = bootstrapAccessToken();
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);

      await expect(pending).resolves.toBe(false);
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().sessionExpired).toBe(true);
    });

    it('does not retry a refusal that is not a 401', async () => {
      const { bootstrapAccessToken } = await getModule();
      const postSpy = vi.spyOn(axios, 'post').mockRejectedValueOnce(new Error('network down'));

      await expect(bootstrapAccessToken()).resolves.toBe(false);
      expect(postSpy).toHaveBeenCalledTimes(1);
    });

    it('waits for a sibling tab holding the refresh lock before presenting the cookie', async () => {
      const { locks, requested } = installFakeLocks();
      const { bootstrapAccessToken, REFRESH_LOCK_NAME } = await getModule();
      const postSpy = vi
        .spyOn(axios, 'post')
        .mockResolvedValueOnce({ data: { access: 'after-sibling' } });

      // The sibling tab is mid-rotation: it holds the lock until its response lands.
      let releaseSibling!: () => void;
      const siblingHolds = new Promise<void>((resolve) => {
        releaseSibling = resolve;
      });
      const sibling = locks.request(REFRESH_LOCK_NAME, () => siblingHolds);

      const pending = bootstrapAccessToken();
      await Promise.resolve();
      await Promise.resolve();
      // Presenting the cookie now would race the sibling's rotation with a stale value.
      expect(postSpy).not.toHaveBeenCalled();

      releaseSibling();
      await sibling;
      await expect(pending).resolves.toBe(true);
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(requested).toEqual([REFRESH_LOCK_NAME, REFRESH_LOCK_NAME]);
      expect(useAuthStore.getState().accessToken).toBe('after-sibling');
    });

    // #4296: a hung refresh in a sibling tab must not silence this one for the full
    // refresh timeout, and the wait must be visible.
    describe('held lock (#4296)', () => {
      /** A lock that is held forever, honoring `signal` while a waiter queues. */
      function installStuckLock() {
        const locks = {
          request: (_name: string, opts: LockOptions, cb: () => Promise<unknown>) =>
            new Promise((resolve, reject) => {
              void cb;
              opts.signal?.addEventListener('abort', () =>
                reject(new DOMException('The request was aborted.', 'AbortError')),
              );
              void resolve;
            }),
        };
        Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
      }

      it('shows "waiting on another tab" after 1s and falls through to its own refresh after 6s', async () => {
        vi.useFakeTimers();
        installStuckLock();
        const { bootstrapAccessToken, LOCK_STALL_NOTICE_MS, LOCK_WAIT_MS } = await getModule();
        const postSpy = vi
          .spyOn(axios, 'post')
          .mockResolvedValueOnce({ data: { access: 'own-attempt' } });

        const pending = bootstrapAccessToken();
        await vi.advanceTimersByTimeAsync(LOCK_STALL_NOTICE_MS - 1);
        expect(useAuthStore.getState().waitingOnSiblingTab).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(useAuthStore.getState().waitingOnSiblingTab).toBe(true);
        expect(postSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS - LOCK_STALL_NOTICE_MS);
        await expect(pending).resolves.toBe(true);
        expect(postSpy).toHaveBeenCalledTimes(1);
        expect(useAuthStore.getState().waitingOnSiblingTab).toBe(false);
        expect(useAuthStore.getState().accessToken).toBe('own-attempt');
      });

      it('does not flag a wait that resolves inside the notice threshold', async () => {
        installFakeLocks();
        const { bootstrapAccessToken } = await getModule();
        vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access: 'quick' } });
        await expect(bootstrapAccessToken()).resolves.toBe(true);
        expect(useAuthStore.getState().waitingOnSiblingTab).toBe(false);
      });
    });

    // #4296: a sibling tab's session change reaches this tab. A second channel
    // instance stands in for the sibling; a channel never hears its own posts.
    describe('sibling tab messages (#4296)', () => {
      let sibling: BroadcastChannel;
      beforeEach(() => {
        sibling = new BroadcastChannel('trueppm-auth');
      });
      afterEach(() => sibling.close());

      it('expiry in a sibling tab shows the modal here, without echoing it back', async () => {
        await getModule();
        useAuthStore.setState({
          isAuthenticated: true,
          accessToken: 'live',
          sessionExpired: false,
        });
        sibling.postMessage({ type: 'expired' });
        // Installed after the sibling's own post, so it sees only what THIS tab sends.
        const posted = vi.spyOn(BroadcastChannel.prototype, 'postMessage');
        await vi.waitFor(() => expect(useAuthStore.getState().sessionExpired).toBe(true));
        expect(posted).not.toHaveBeenCalled();
      });

      it("a sibling sign-out also drops this tab's cached reads", async () => {
        await getModule();
        queryClient.setQueryData(['projects'], [{ id: 'p1' }]);
        useAuthStore.setState({
          isAuthenticated: true,
          accessToken: 'live',
          sessionExpired: false,
        });
        sibling.postMessage({ type: 'cleared' });
        await vi.waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(false));
        expect(queryClient.getQueryData(['projects'])).toBeUndefined();
      });

      describe('a sibling signs in as someone else', () => {
        afterEach(() => queryClient.clear());

        async function restoreWith(me: () => Promise<unknown>) {
          await getModule();
          queryClient.setQueryData(['current-user'], { id: '7' });
          queryClient.setQueryData(['projects'], [{ id: 'p1' }]);
          vi.spyOn(axios, 'post').mockResolvedValue({ data: { access: 'minted-here' } });
          const get = vi.spyOn(axios, 'get').mockImplementation(me as never);
          useAuthStore.setState({
            isAuthenticated: false,
            accessToken: null,
            sessionExpired: true,
          });
          sibling.postMessage({ type: 'restored' });
          await vi.waitFor(() => expect(useAuthStore.getState().accessToken).toBe('minted-here'));
          return get;
        }

        it("clears the previous user's cache before the tab goes live", async () => {
          const get = await restoreWith(() => Promise.resolve({ data: { id: '9' } }));
          expect(get).toHaveBeenCalledWith(
            '/api/v1/auth/me/',
            expect.objectContaining({ headers: { Authorization: 'Bearer minted-here' } }),
          );
          expect(queryClient.getQueryData(['projects'])).toBeUndefined();
        });

        it('keeps the cache when the same user signed back in', async () => {
          await restoreWith(() => Promise.resolve({ data: { id: '7' } }));
          expect(queryClient.getQueryData(['projects'])).toEqual([{ id: 'p1' }]);
        });

        it('clears the cache when there is no cached identity to compare against', async () => {
          await getModule();
          queryClient.setQueryData(['projects'], [{ id: 'p1' }]);
          vi.spyOn(axios, 'post').mockResolvedValue({ data: { access: 'minted-here' } });
          useAuthStore.setState({
            isAuthenticated: false,
            accessToken: null,
            sessionExpired: true,
          });
          sibling.postMessage({ type: 'restored' });
          await vi.waitFor(() => expect(useAuthStore.getState().accessToken).toBe('minted-here'));
          expect(queryClient.getQueryData(['projects'])).toBeUndefined();
        });

        it('clears the cache when the identity cannot be confirmed', async () => {
          await restoreWith(() => Promise.reject(new Error('network')));
          expect(queryClient.getQueryData(['projects'])).toBeUndefined();
        });
      });

      it('ignores a sibling expiry when this tab holds no session (e.g. on /login)', async () => {
        await getModule();
        useAuthStore.setState({ isAuthenticated: false, accessToken: null, sessionExpired: false });
        sibling.postMessage({ type: 'expired' });
        await new Promise((r) => setTimeout(r, 30));
        expect(useAuthStore.getState().sessionExpired).toBe(false);
      });

      it("a sibling sign-in clears this tab's expired state by minting its own token", async () => {
        await getModule();
        vi.spyOn(axios, 'post').mockResolvedValue({ data: { access: 'minted-here' } });
        useAuthStore.setState({ isAuthenticated: false, accessToken: null, sessionExpired: true });
        sibling.postMessage({ type: 'restored' });
        await vi.waitFor(() => expect(useAuthStore.getState().accessToken).toBe('minted-here'));
        expect(useAuthStore.getState().sessionExpired).toBe(false);
      });

      it('a sibling sign-out signs this tab out too', async () => {
        await getModule();
        useAuthStore.setState({
          isAuthenticated: true,
          accessToken: 'live',
          sessionExpired: false,
        });
        sibling.postMessage({ type: 'cleared' });
        await vi.waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(false));
      });
    });

    // The 401 response interceptor shares `refreshAccessToken()` (client.ts:219)
    // with `bootstrapAccessToken` — every case above drives the bootstrap path
    // only, which left the mid-session path's use of the same retry-under-lock
    // unexercised. A protected request's 401 here is a DIFFERENT 401 from the
    // refresh's own: the interceptor sees the protected request refused, calls
    // refreshAccessToken(), and it is that refresh call which is refused-then-
    // retried by a sibling's rotation before the original request is replayed.
    it('mid-session 401 on a protected request recovers via the retried refresh and stays signed in', async () => {
      vi.useFakeTimers();
      const client = await getApiClient();
      const { rejected } = getResponseInterceptors(client);
      const { REFRESH_RETRY_DELAY_MS } = await getModule();

      const postSpy = vi
        .spyOn(axios, 'post')
        .mockRejectedValueOnce(refused401())
        .mockResolvedValueOnce({ data: { access: 'mid-session-rotated-access' } });

      const originalAdapter = client.defaults.adapter;
      const adapterSpy = vi
        .fn()
        .mockResolvedValue({ status: 200, data: { ok: true }, headers: {}, config: {} });
      client.defaults.adapter = adapterSpy;

      const protectedRequest401 = Object.assign(new Error('Unauthorized'), {
        isAxiosError: true,
        response: { status: 401 },
        config: { headers: {} },
      });

      try {
        const pending = rejected(protectedRequest401);
        await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
        await pending;

        // Refresh was refused once (the sibling's stale cookie) and retried once.
        expect(postSpy).toHaveBeenCalledTimes(2);
        expect(useAuthStore.getState().accessToken).toBe('mid-session-rotated-access');
        expect(useAuthStore.getState().sessionExpired).toBe(false);
        // The ORIGINAL protected request was replayed with the recovered token —
        // the interceptor never gave up on the request that triggered it.
        expect(adapterSpy).toHaveBeenCalledTimes(1);
        const retryConfig = adapterSpy.mock.calls[0][0] as { headers?: Record<string, string> };
        expect(retryConfig.headers?.Authorization).toBe('Bearer mid-session-rotated-access');
      } finally {
        client.defaults.adapter = originalAdapter;
      }
    });
  });
});

describe('apiClient — read-only demo refusal (ADR-1197 D3, #3926)', () => {
  beforeEach(() => {
    useToastStore.getState().clear();
    // The toast is gated on the deployment mode as well as the refusal code, so the
    // cached `/edition/` answer is part of the fixture.
    queryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: true });
  });

  afterEach(() => {
    useToastStore.getState().clear();
    queryClient.removeQueries({ queryKey: ['edition'] });
  });

  function demoRefusal(config: Record<string, unknown> = {}): AxiosError {
    const err = new AxiosError('Request failed with status code 403');
    err.config = config as unknown as AxiosError['config'];
    err.response = {
      status: 403,
      data: { detail: 'read-only demo', code: 'demo_read_only' },
    } as AxiosResponse;
    return err;
  }

  it('raises an info toast and STILL rejects, so every onError keeps running', async () => {
    const client = await getApiClient();
    const { rejected } = getResponseInterceptors(client);
    await expect(rejected(demoRefusal())).rejects.toBeDefined();

    const toast = useToastStore.getState().transient;
    expect(toast?.message).toBe("Read-only demo — that change wasn't saved.");
    // `info`, not `error`: the mode working is not a failure.
    expect(toast?.variant).toBe('info');
  });

  it('stands down for a caller that renders the refusal itself', async () => {
    const client = await getApiClient();
    const { rejected } = getResponseInterceptors(client);
    await expect(rejected(demoRefusal({ demoRefusalHandled: true }))).rejects.toBeDefined();
    expect(useToastStore.getState().transient).toBeNull();
  });

  it('stays silent on a deployment that is NOT a demo, even with the code present', async () => {
    // Both facts are required: the code is the server's word for the refusal, the
    // cached mode is what says this deployment is the demo.
    queryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: false });
    const client = await getApiClient();
    const { rejected } = getResponseInterceptors(client);
    await expect(rejected(demoRefusal())).rejects.toBeDefined();
    expect(useToastStore.getState().transient).toBeNull();
  });

  it('leaves an ordinary 403 to the surfaces that already handle it', async () => {
    const client = await getApiClient();
    const { rejected } = getResponseInterceptors(client);
    const err = new AxiosError('Request failed with status code 403');
    err.config = {} as AxiosError['config'];
    err.response = { status: 403, data: { detail: 'Not permitted.' } } as AxiosResponse;
    await expect(rejected(err)).rejects.toBeDefined();
    expect(useToastStore.getState().transient).toBeNull();
  });
});

describe('apiClient — service-worker kill switch (ADR-1523 §2)', () => {
  function lastResponseInterceptor(client: Awaited<ReturnType<typeof getApiClient>>) {
    const all = (client.interceptors.response as unknown as { handlers: unknown[] }).handlers;
    return getResponseInterceptors(client, all.length - 1);
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('unregisters workers when a response carries the disable header, and passes it through', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
      configurable: true,
    });
    const client = await getApiClient();
    const response = { data: {}, headers: { 'x-trueppm-service-worker': 'disable' } };
    expect(lastResponseInterceptor(client).fulfilled(response)).toBe(response);
    await vi.waitFor(() => expect(unregister).toHaveBeenCalled());
  });

  it('rejects an error response unchanged', async () => {
    const client = await getApiClient();
    const err = new AxiosError('boom', '500', undefined, undefined, {
      status: 500,
      headers: {},
    } as AxiosResponse);
    await expect(lastResponseInterceptor(client).rejected(err)).rejects.toBe(err);
  });
});
