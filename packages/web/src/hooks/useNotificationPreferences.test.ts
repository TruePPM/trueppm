import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
  type NotificationPreferenceRow,
} from './useNotificationPreferences';

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, patch: patchMock },
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

const rows: NotificationPreferenceRow[] = [
  {
    id: 1,
    event_type: 'mention',
    channel: 'in_app',
    enabled: true,
    updated_at: '2026-05-20T00:00:00Z',
  },
  {
    id: 2,
    event_type: 'mention',
    channel: 'email',
    enabled: false,
    updated_at: '2026-05-20T00:00:00Z',
  },
];

describe('useNotificationPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unwraps the paginated envelope into a flat preference array (#792)', async () => {
    // The real list endpoint returns the DRF PageNumberPagination envelope,
    // not a bare array. The previous mock returned `{ data: rows }`, which let
    // the hook ship returning the envelope object — `for...of preferences` then
    // threw "preferences is not iterable" and crashed the page.
    getMock.mockResolvedValue({
      data: { count: rows.length, next: null, previous: null, results: rows },
    });
    const { result } = renderHook(() => useNotificationPreferences(), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/me/notification-preferences/');
    expect(result.current.preferences).toEqual(rows);
    // Guard the crash directly: the result must be iterable.
    expect(Array.isArray(result.current.preferences)).toBe(true);
  });
});

describe('useUpdateNotificationPreference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('optimistically flips the toggle then settles via invalidate', async () => {
    const qc = newQc();
    qc.setQueryData(['me-notification-preferences'], rows);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    patchMock.mockResolvedValueOnce({ data: { ...rows[1], enabled: true } });

    const { result } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({ id: 2, enabled: true });
    });
    expect(patchMock).toHaveBeenCalledWith('/me/notification-preferences/2/', {
      enabled: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['me-notification-preferences'],
    });
  });

  it('restores the previous matrix when the PATCH fails', async () => {
    const qc = newQc();
    qc.setQueryData(['me-notification-preferences'], rows);
    patchMock.mockRejectedValueOnce(new Error('500'));
    const { result } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      try {
        await result.current.mutateAsync({ id: 1, enabled: false });
      } catch {
        // expected
      }
    });
    const cached = qc.getQueryData<NotificationPreferenceRow[]>([
      'me-notification-preferences',
    ]);
    expect(cached?.find((r) => r.id === 1)?.enabled).toBe(true);
  });
});
