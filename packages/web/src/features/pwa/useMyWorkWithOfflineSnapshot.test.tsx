import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { AxiosError } from 'axios';
import { useMyWorkWithOfflineSnapshot } from './useMyWorkWithOfflineSnapshot';

const state = vi.hoisted(() => ({
  query: { data: undefined as unknown, error: null as unknown, isLoading: false },
  online: true,
  user: null as { id: string } | null,
  snapshot: null as unknown,
}));
const store = vi.hoisted(() => ({
  save: vi.fn(),
  purge: vi.fn(),
}));

vi.mock('@/hooks/useMyWork', () => ({
  useMyWork: () => ({
    ...state.query,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => state.online }));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ user: state.user }) }));
vi.mock('@/lib/pwa/pwaStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pwa/pwaStore')>();
  return {
    ...actual,
    saveMyWorkSnapshot: store.save,
    purgePwaUserData: store.purge,
    loadMyWorkSnapshot: () => Promise.resolve(state.snapshot),
  };
});

const PAGES = { pages: [{ results: [], next: null }], pageParams: [null] };
const SNAP = { key: 'me', userId: '7', savedAt: 1_700_000_000_000, data: PAGES };

beforeEach(() => {
  state.query = { data: undefined, error: null, isLoading: false };
  state.online = true;
  state.user = null;
  state.snapshot = null;
  store.save.mockReset();
  store.purge.mockReset();
});

describe('useMyWorkWithOfflineSnapshot', () => {
  it('saves each live load for the signed-in user and passes it through', () => {
    state.query.data = PAGES;
    state.user = { id: '7' };
    const { result } = renderHook(() => useMyWorkWithOfflineSnapshot());
    expect(result.current.data).toBe(PAGES);
    expect(result.current.snapshotSavedAt).toBeNull();
    expect(store.save).toHaveBeenCalledWith('7', PAGES);
  });

  it('serves the saved copy when offline with no live data', async () => {
    state.online = false;
    state.snapshot = SNAP;
    const { result } = renderHook(() => useMyWorkWithOfflineSnapshot());
    await waitFor(() => expect(result.current.snapshotSavedAt).toBe(SNAP.savedAt));
    expect(result.current.data).toBe(PAGES);
    expect(result.current.error).toBeNull();
  });

  it('serves the saved copy on a network failure, but never over an HTTP error', async () => {
    state.snapshot = SNAP;
    state.query.error = new AxiosError('Network Error', 'ERR_NETWORK');
    const { result, rerender } = renderHook(() => useMyWorkWithOfflineSnapshot());
    await waitFor(() => expect(result.current.snapshotSavedAt).toBe(SNAP.savedAt));

    state.query.error = new AxiosError('boom', '500', undefined, undefined, {
      status: 500,
    } as never);
    rerender();
    expect(result.current.snapshotSavedAt).toBeNull();
    expect(result.current.error).toBe(state.query.error);
  });

  it('reports offline-with-nothing-saved', async () => {
    state.online = false;
    const { result } = renderHook(() => useMyWorkWithOfflineSnapshot());
    await waitFor(() => expect(result.current.offlineWithoutSnapshot).toBe(true));
  });

  it('purges a copy that belongs to a different signed-in user', async () => {
    state.online = false;
    state.snapshot = SNAP;
    state.user = { id: '8' };
    const { result } = renderHook(() => useMyWorkWithOfflineSnapshot());
    await waitFor(() => expect(store.purge).toHaveBeenCalled());
    expect(result.current.snapshotSavedAt).toBeNull();
  });
});
