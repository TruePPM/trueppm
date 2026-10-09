import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RELOAD_KEY,
  RELOAD_WINDOW_MS,
  clearChunkReloadGuard,
  installChunkReloadHandler,
  reloadOnceForChunkFailure,
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
});
