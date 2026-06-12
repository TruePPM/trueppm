import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useNotifications,
  useUnreadNotificationCount,
  useUpdateNotification,
  useMarkAllRead,
} from './useNotifications';

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, patch: patchMock, post: postMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const sampleRow = {
  id: 'n1',
  recipient: 'u1',
  mention: null,
  event_type: '',
  subject: '',
  body: '',
  project: 'p1',
  is_read: false,
  is_archived: false,
  created_at: '2026-05-20T00:00:00Z',
  read_at: null,
  snippet: 'You were mentioned',
  task_id: 't1',
};

describe('useUnreadNotificationCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the unread count from the API', async () => {
    getMock.mockResolvedValue({ data: { count: 4, next: null, previous: null, results: [] } });
    const { result } = renderHook(() => useUnreadNotificationCount(), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/me/notifications/', {
      params: { unread_only: 'true', limit: 0 },
    });
    expect(result.current.count).toBe(4);
  });

  it('falls back to 0 when the API omits the count', async () => {
    getMock.mockResolvedValue({ data: { next: null, previous: null, results: [] } });
    const { result } = renderHook(() => useUnreadNotificationCount(), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.count).toBe(0);
  });
});

describe('useNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends no filter params for the "all" tab', async () => {
    getMock.mockResolvedValue({
      data: { count: 1, next: null, previous: null, results: [sampleRow] },
    });
    const { result } = renderHook(() => useNotifications({ filter: 'all' }), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/me/notifications/', { params: {} });
    expect(result.current.notifications).toHaveLength(1);
  });

  it('sets unread_only=true for the "unread" tab', async () => {
    getMock.mockResolvedValue({
      data: { count: 0, next: null, previous: null, results: [] },
    });
    renderHook(() => useNotifications({ filter: 'unread' }), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/me/notifications/', {
        params: { unread_only: 'true' },
      }),
    );
  });

  it('sets archived=true for the "archived" tab', async () => {
    getMock.mockResolvedValue({
      data: { count: 0, next: null, previous: null, results: [] },
    });
    renderHook(() => useNotifications({ filter: 'archived' }), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/me/notifications/', {
        params: { archived: 'true' },
      }),
    );
  });
});

describe('useUpdateNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PATCHes the row and invalidates the bell + list keys on success', async () => {
    const qc = newQc();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    patchMock.mockResolvedValueOnce({ data: { ...sampleRow, is_read: true } });
    const { result } = renderHook(() => useUpdateNotification(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({ id: 'n1', is_read: true });
    });
    expect(patchMock).toHaveBeenCalledWith('/me/notifications/n1/', { is_read: true });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['me-notifications-unread-count'],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me-notifications'] });
  });
});

describe('useMarkAllRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs to mark-all-read and invalidates the bell + list keys', async () => {
    const qc = newQc();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    postMock.mockResolvedValueOnce({ data: { updated: 7 } });
    const { result } = renderHook(() => useMarkAllRead(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      const res = await result.current.mutateAsync();
      expect(res.updated).toBe(7);
    });
    expect(postMock).toHaveBeenCalledWith('/me/notifications/mark-all-read/');
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['me-notifications-unread-count'],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me-notifications'] });
  });
});
