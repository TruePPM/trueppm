import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  DND_ERROR_ANNOUNCEMENT,
  dndAnnouncement,
  useUpdateNotificationSettings,
} from './useUpdateNotificationSettings';

/**
 * Hook-level coverage for the account-wide DND mutation (#1707): PATCHes
 * /me/notification-settings/, optimistically flips the cached ['current-user']
 * dnd_enabled so the bell reacts instantly, and rolls back on error.
 */

const patchMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe('dndAnnouncement', () => {
  it('returns the on / off strings from one source', () => {
    expect(dndAnnouncement(true)).toBe('Do Not Disturb on — emails and push paused');
    expect(dndAnnouncement(false)).toBe('Do Not Disturb off');
    expect(DND_ERROR_ANNOUNCEMENT).toBe("Couldn't update Do Not Disturb. Try again.");
  });
});

describe('useUpdateNotificationSettings', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newClient();
    vi.clearAllMocks();
  });

  it('PATCHes /me/notification-settings/ with the desired dnd_enabled', async () => {
    patchMock.mockResolvedValue({ data: { dnd_enabled: true } });
    const { result } = renderHook(() => useUpdateNotificationSettings(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/me/notification-settings/', { dnd_enabled: true });
  });

  it('optimistically flips the cached current-user dnd_enabled', async () => {
    qc.setQueryData(['current-user'], { id: 'u1', dnd_enabled: false });
    // A never-resolving PATCH so the optimistic value is observable.
    patchMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useUpdateNotificationSettings(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(true);
    await waitFor(() =>
      expect(qc.getQueryData<{ dnd_enabled: boolean }>(['current-user'])?.dnd_enabled).toBe(true),
    );
  });

  it('rolls the cached value back when the PATCH fails', async () => {
    qc.setQueryData(['current-user'], { id: 'u1', dnd_enabled: false });
    patchMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useUpdateNotificationSettings(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(true);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData<{ dnd_enabled: boolean }>(['current-user'])?.dnd_enabled).toBe(false);
  });
});
