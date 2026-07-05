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
  useSnoozeNotification,
  useMuteNotificationType,
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
  snoozed_until: null,
  category: 'mentions',
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

  it('requests page 1 with no filter params for the "all" tab', async () => {
    getMock.mockResolvedValue({
      data: { count: 1, next: null, previous: null, results: [sampleRow] },
    });
    const { result } = renderHook(() => useNotifications({ filter: 'all' }), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/me/notifications/', { params: { page: 1 } });
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
        params: { page: 1, unread_only: 'true' },
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
        params: { page: 1, archived: 'true' },
      }),
    );
  });

  it('sets snoozed=true for the "snoozed" tab', async () => {
    getMock.mockResolvedValue({
      data: { count: 0, next: null, previous: null, results: [] },
    });
    renderHook(() => useNotifications({ filter: 'snoozed' }), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/me/notifications/', {
        params: { page: 1, snoozed: 'true' },
      }),
    );
  });

  it('threads a non-all category into the query params', async () => {
    getMock.mockResolvedValue({
      data: { count: 0, next: null, previous: null, results: [] },
    });
    renderHook(() => useNotifications({ filter: 'all', category: 'tasks' }), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/me/notifications/', {
        params: { page: 1, category: 'tasks' },
      }),
    );
  });

  it('omits the category param when category is "all"', async () => {
    getMock.mockResolvedValue({
      data: { count: 0, next: null, previous: null, results: [] },
    });
    renderHook(() => useNotifications({ filter: 'unread', category: 'all' }), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/me/notifications/', {
        params: { page: 1, unread_only: 'true' },
      }),
    );
  });

  it('keys the cache by filter AND category so switching either re-fetches', async () => {
    getMock.mockResolvedValue({
      data: { count: 0, next: null, previous: null, results: [] },
    });
    const qc = newQc();
    // Two hooks that share the read-state filter but differ on category must
    // hit the API separately (distinct query keys), not collide on one slot.
    renderHook(() => useNotifications({ filter: 'all', category: 'mentions' }), {
      wrapper: makeWrapper(qc),
    });
    renderHook(() => useNotifications({ filter: 'all', category: 'signals' }), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/me/notifications/', {
        params: { page: 1, category: 'mentions' },
      }),
    );
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/me/notifications/', {
        params: { page: 1, category: 'signals' },
      }),
    );
  });

  it('exposes hasNextPage when the server returns a next URL and appends the next page', async () => {
    // Page 1 has a `next` cursor; page 2 closes it out.
    getMock.mockImplementation((_url: string, opts: { params: { page: number } }) => {
      if (opts.params.page === 1) {
        return Promise.resolve({
          data: {
            count: 2,
            next: 'https://api.test/me/notifications/?page=2',
            previous: null,
            results: [{ ...sampleRow, id: 'n1' }],
          },
        });
      }
      return Promise.resolve({
        data: { count: 2, next: null, previous: null, results: [{ ...sampleRow, id: 'n2' }] },
      });
    });

    const { result } = renderHook(() => useNotifications({ filter: 'all' }), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));
    expect(getMock).toHaveBeenCalledWith('/me/notifications/', { params: { page: 2 } });
    expect(result.current.hasNextPage).toBe(false);
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

describe('useSnoozeNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs a preset to the snooze action and invalidates bell + list', async () => {
    const qc = newQc();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    postMock.mockResolvedValueOnce({
      data: { ...sampleRow, snoozed_until: '2026-05-20T01:00:00Z' },
    });
    const { result } = renderHook(() => useSnoozeNotification(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({ id: 'n1', preset: '1h' });
    });
    expect(postMock).toHaveBeenCalledWith('/me/notifications/n1/snooze/', { preset: '1h' });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['me-notifications-unread-count'],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me-notifications'] });
  });

  it('POSTs until:null to un-snooze', async () => {
    postMock.mockResolvedValueOnce({ data: { ...sampleRow, snoozed_until: null } });
    const { result } = renderHook(() => useSnoozeNotification(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({ id: 'n1', until: null });
    });
    expect(postMock).toHaveBeenCalledWith('/me/notifications/n1/snooze/', { until: null });
  });
});

describe('useMuteNotificationType', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the in-app preference row and PATCHes it off', async () => {
    const qc = newQc();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    getMock.mockResolvedValueOnce({
      data: {
        count: 2,
        next: null,
        previous: null,
        results: [
          { id: 10, event_type: 'task.assigned', channel: 'email', enabled: true },
          { id: 11, event_type: 'task.assigned', channel: 'in_app', enabled: true },
        ],
      },
    });
    patchMock.mockResolvedValueOnce({
      data: { id: 11, event_type: 'task.assigned', channel: 'in_app', enabled: false },
    });
    const { result } = renderHook(() => useMuteNotificationType(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({ eventType: 'task.assigned' });
    });
    // Muting targets the IN-APP row (id 11), never email (id 10).
    expect(patchMock).toHaveBeenCalledWith('/me/notification-preferences/11/', { enabled: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me-notification-preferences'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me-notifications'] });
  });

  it('un-mutes (enabled:true) when mute:false is passed (the Undo path)', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        count: 1,
        next: null,
        previous: null,
        results: [{ id: 11, event_type: 'task.assigned', channel: 'in_app', enabled: false }],
      },
    });
    patchMock.mockResolvedValueOnce({
      data: { id: 11, event_type: 'task.assigned', channel: 'in_app', enabled: true },
    });
    const { result } = renderHook(() => useMuteNotificationType(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({ eventType: 'task.assigned', mute: false });
    });
    expect(patchMock).toHaveBeenCalledWith('/me/notification-preferences/11/', { enabled: true });
  });
});
