import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RELOAD_KEY,
  RELOAD_WINDOW_MS,
  clearChunkReloadGuard,
  IMPORT_RETRY_DELAYS_MS,
  installChunkReloadHandler,
  reloadOnceForChunkFailure,
  withImportRetry,
} from './chunkReload';

describe('chunkReload', () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('reloads on the first failure and records the guard', () => {
    const reload = vi.fn();
    expect(reloadOnceForChunkFailure({ now: () => 1000, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe('1000');
  });

  it('does not reload again within the window', () => {
    const reload = vi.fn();
    reloadOnceForChunkFailure({ now: () => 1000, reload });
    expect(reloadOnceForChunkFailure({ now: () => 1000 + RELOAD_WINDOW_MS - 1, reload })).toBe(
      false,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('may reload again once the window has elapsed', () => {
    const reload = vi.fn();
    reloadOnceForChunkFailure({ now: () => 1000, reload });
    expect(reloadOnceForChunkFailure({ now: () => 1000 + RELOAD_WINDOW_MS, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not crash or reload when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const reload = vi.fn();
    expect(reloadOnceForChunkFailure({ reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => clearChunkReloadGuard()).not.toThrow();
  });

  it('does not reload while offline or with queued writes', () => {
    const reload = vi.fn();
    expect(reloadOnceForChunkFailure({ reload, isOnline: () => false })).toBe(false);
    expect(reloadOnceForChunkFailure({ reload, pendingWriteCount: () => 2 })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
  });

  it('clears the guard', () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, '5');
    clearChunkReloadGuard();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
  });

  describe('installChunkReloadHandler', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it.each([
      ['queued writes', { pendingWriteCount: () => 1 }],
      ['offline', { isOnline: () => false }],
    ])('does not reload or swallow the error with %s', (_name, deps) => {
      const reload = vi.fn();
      const teardown = installChunkReloadHandler({ reload, ...deps });
      const ev = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(ev);
      expect(reload).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
      teardown();
    });

    it('reloads on vite:preloadError, suppresses the default, and clears the guard after the window', () => {
      const reload = vi.fn();
      const teardown = installChunkReloadHandler({ reload });
      const ev = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(ev);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(ev.defaultPrevented).toBe(true);

      const second = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(second);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(second.defaultPrevented).toBe(false);

      vi.advanceTimersByTime(RELOAD_WINDOW_MS);
      expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
      teardown();
      window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  describe('withImportRetry (ADR-1249)', () => {
    const chunkError = () => new TypeError('Failed to fetch dynamically imported module');
    const PENDING = Symbol('pending');
    // Settles to PENDING if the loader has neither resolved nor rejected after
    // every queued microtask/timer callback has run.
    const settle = async <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), 0))]);

    it('retries with the configured backoff, and a retry that succeeds means no reload', async () => {
      const reload = vi.fn();
      const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
      const load = vi
        .fn<() => Promise<{ default: string }>>()
        .mockRejectedValueOnce(chunkError())
        .mockResolvedValueOnce({ default: 'Page' });
      await expect(
        withImportRetry(load, { reload, sleep, isOnline: () => true })(),
      ).resolves.toEqual({
        default: 'Page',
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(IMPORT_RETRY_DELAYS_MS[0]);
      expect(reload).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
    });

    it('retries twice, then takes the existing one-time reload path', async () => {
      const reload = vi.fn();
      const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
      const load = vi.fn(() => Promise.reject(chunkError()));
      const result = withImportRetry(load, {
        reload,
        sleep,
        isOnline: () => true,
        now: () => 1000,
      })();
      expect(await settle(result)).toBe(PENDING);
      expect(load).toHaveBeenCalledTimes(1 + IMPORT_RETRY_DELAYS_MS.length);
      expect(IMPORT_RETRY_DELAYS_MS).toHaveLength(2);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...IMPORT_RETRY_DELAYS_MS]);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe('1000');
    });

    it('rethrows to the route boundary when every retry fails and the reload guard is spent', async () => {
      window.sessionStorage.setItem(CHUNK_RELOAD_KEY, '1000');
      const reload = vi.fn();
      const err = chunkError();
      const load = vi.fn(() => Promise.reject(err));
      await expect(
        withImportRetry(load, { reload, sleep: () => Promise.resolve(), now: () => 1001 })(),
      ).rejects.toBe(err);
      expect(load).toHaveBeenCalledTimes(3);
      expect(reload).not.toHaveBeenCalled();
    });

    it('does not retry offline, and does not reload either', async () => {
      const reload = vi.fn();
      const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
      const err = chunkError();
      const load = vi.fn(() => Promise.reject(err));
      await expect(withImportRetry(load, { reload, sleep, isOnline: () => false })()).rejects.toBe(
        err,
      );
      expect(load).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it('keeps the global vite:preloadError handler from reloading mid-retry', async () => {
      const reload = vi.fn();
      const teardown = installChunkReloadHandler({ reload });
      let fireDuringLoad = true;
      let ev: Event | undefined;
      const load = vi.fn(() => {
        if (fireDuringLoad) {
          fireDuringLoad = false;
          ev = new Event('vite:preloadError', { cancelable: true });
          window.dispatchEvent(ev);
          return Promise.reject(chunkError());
        }
        return Promise.resolve({ default: 'Page' });
      });
      await expect(
        withImportRetry(load, { sleep: () => Promise.resolve(), isOnline: () => true })(),
      ).resolves.toEqual({ default: 'Page' });
      expect(reload).not.toHaveBeenCalled();
      expect(ev?.defaultPrevented).toBe(false);
      // Outside a wrapped import the handler acts as before.
      window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
      expect(reload).toHaveBeenCalledTimes(1);
      teardown();
    });

    it('inherits the pending-write guard installed by installChunkReloadHandler', async () => {
      const reload = vi.fn();
      const teardown = installChunkReloadHandler({ reload, pendingWriteCount: () => 3 });
      const err = chunkError();
      await expect(
        withImportRetry(() => Promise.reject(err), {
          sleep: () => Promise.resolve(),
          isOnline: () => true,
        })(),
      ).rejects.toBe(err);
      expect(reload).not.toHaveBeenCalled();
      teardown();
    });
  });
});
