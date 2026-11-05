import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/stores/authStore';
import { hasDemoSessionMarker, clearDemoSessionMarker } from './demoMarker';
import {
  requestSession,
  silentDemoLogin,
  SILENT_EDITION_TIMEOUT_MS,
  SILENT_TOKEN_TIMEOUT_MS,
} from './demoSession';

const mocked = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: mocked }));

const HINT = { username: 'demo@trueppm.com', password: 'trueppm-demo' };

describe('silentDemoLogin (#4500)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    queryClient.clear();
    clearDemoSessionMarker();
    useAuthStore.setState({ accessToken: null, isAuthenticated: false });
  });

  it('signs in session-only with the published credential on a demo host', async () => {
    mocked.get.mockResolvedValue({
      data: { edition: 'community', demo_read_only: true, demo_login_hint: HINT },
    });
    mocked.post.mockResolvedValue({ data: { access: 'tok' } });

    await expect(silentDemoLogin()).resolves.toBe(true);
    expect(mocked.post).toHaveBeenCalledWith(
      '/api/v1/auth/token/',
      { username: HINT.username, password: HINT.password, remember_me: false },
      { timeout: SILENT_TOKEN_TIMEOUT_MS },
    );
    expect(useAuthStore.getState().accessToken).toBe('tok');
  });

  it.each([
    ['a normal install', { edition: 'community', demo_read_only: false, demo_login_hint: null }],
    [
      'a hint without the demo flag',
      { edition: 'community', demo_read_only: false, demo_login_hint: HINT },
    ],
    [
      'the flag without a hint',
      { edition: 'community', demo_read_only: true, demo_login_hint: null },
    ],
  ])('never posts a credential for %s', async (_label, edition) => {
    mocked.get.mockResolvedValue({ data: edition });
    await expect(silentDemoLogin()).resolves.toBe(false);
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('resolves false when the edition read fails', async () => {
    mocked.get.mockRejectedValue(new Error('offline'));
    await expect(silentDemoLogin()).resolves.toBe(false);
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('bounds the edition read with a timeout and resolves false when it fails', async () => {
    mocked.get.mockRejectedValue(
      Object.assign(new Error('timeout of 4000ms exceeded'), { code: 'ECONNABORTED' }),
    );
    await expect(silentDemoLogin()).resolves.toBe(false);
    expect(mocked.get).toHaveBeenCalledWith('/api/v1/edition/', {
      timeout: SILENT_EDITION_TIMEOUT_MS,
    });
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('bounds the token POST with a timeout and resolves false when it hangs', async () => {
    mocked.get.mockResolvedValue({
      data: { edition: 'community', demo_read_only: true, demo_login_hint: HINT },
    });
    mocked.post.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    await expect(silentDemoLogin()).resolves.toBe(false);
    expect(mocked.post).toHaveBeenCalledWith(
      '/api/v1/auth/token/',
      { username: HINT.username, password: HINT.password, remember_me: false },
      { timeout: SILENT_TOKEN_TIMEOUT_MS },
    );
    expect(hasDemoSessionMarker()).toBe(false);
  });

  it('marks the browser as holding a demo session after a silent login', async () => {
    mocked.get.mockResolvedValue({
      data: { edition: 'community', demo_read_only: true, demo_login_hint: HINT },
    });
    mocked.post.mockResolvedValue({ data: { access: 'tok' } });
    await silentDemoLogin();
    expect(hasDemoSessionMarker()).toBe(true);
  });

  it('resolves false when the login is refused', async () => {
    mocked.get.mockResolvedValue({
      data: { edition: 'community', demo_read_only: true, demo_login_hint: HINT },
    });
    mocked.post.mockRejectedValue(new Error('401'));
    await expect(silentDemoLogin()).resolves.toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('requestSession passes remember through', async () => {
    mocked.post.mockResolvedValue({ data: { access: 'tok' } });
    await requestSession('a', 'b', true);
    expect(mocked.post).toHaveBeenCalledWith('/api/v1/auth/token/', {
      username: 'a',
      password: 'b',
      remember_me: true,
    });
  });
});
