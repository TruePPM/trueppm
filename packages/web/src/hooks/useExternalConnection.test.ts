import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useExternalConnection,
  useSetExternalPoll,
  externalConnectionKey,
  type ExternalConnectionSummary,
} from './useExternalConnection';

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, patch: patchMock },
}));

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

const CONNECTED: ExternalConnectionSummary = {
  name: 'Jira',
  exists: true,
  base_url: 'https://acme.atlassian.net',
  deployment: 'cloud',
  account_email: 'p.patel@acme.com',
  status: 'connected',
  last_synced_at: '2026-05-20T14:00:00Z',
  jql: '',
  project_keys: [],
  poll_enabled: false,
  last_sync: null,
};

beforeEach(() => {
  getMock.mockReset();
  patchMock.mockReset();
});

describe('useExternalConnection', () => {
  it('returns the connection summary when the source is connected', async () => {
    getMock.mockResolvedValue({ data: CONNECTED });
    const { result } = renderHook(() => useExternalConnection('jira'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/me/connections/jira/');
    expect(result.current.isConnected).toBe(true);
    expect(result.current.connection?.account_email).toBe('p.patel@acme.com');
  });

  it('fails soft to "not connected" on a non-200 (e.g. unregistered source)', async () => {
    // The backend returns 400 for a source it does not register — this must
    // degrade to not-connected, never a surfaced error (ADR-0291 risk #2).
    getMock.mockRejectedValue(new Error('Request failed with status code 400'));
    const { result } = renderHook(() => useExternalConnection('jira'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.connection).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  it('does not fetch when disabled (a coming-soon source)', () => {
    renderHook(() => useExternalConnection('github', false), {
      wrapper: wrapper(),
    });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useSetExternalPoll (#3104)', () => {
  it('PATCHes the poll opt-in and seeds the cache from the response', async () => {
    // The response *is* the connection summary, so the switch renders from the
    // server's answer rather than from what the click assumed.
    const updated = { ...CONNECTED, poll_enabled: true };
    patchMock.mockResolvedValue({ data: updated });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    }

    const { result } = renderHook(() => useSetExternalPoll('jira'), { wrapper: Wrapper });
    result.current.mutate(true);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/me/connections/jira/', {
      poll_enabled: true,
    });
    expect(client.getQueryData(externalConnectionKey('jira'))).toEqual(updated);
  });

  it('does not force a refetch after the write — the response already is the summary', async () => {
    // A refetch here would cost a second request per flip against a bucket that
    // throttles GET too (`credential_rotate`, 10/min), and the read hook is
    // fail-soft: a throttled refetch resolves to `null`, which reads as "not
    // connected" and collapses a live connection with nothing to explain it.
    patchMock.mockResolvedValue({ data: { ...CONNECTED, poll_enabled: true } });
    const { result } = renderHook(() => useSetExternalPoll('jira'), {
      wrapper: wrapper(),
    });
    result.current.mutate(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).not.toHaveBeenCalled();
  });

  it('surfaces a failed PATCH instead of failing soft like the read', async () => {
    // The read hook swallows errors on purpose (a source you cannot connect must
    // not render as broken); a *write* that silently no-ops would leave the switch
    // claiming a setting the server never took.
    patchMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useSetExternalPoll('jira'), {
      wrapper: wrapper(),
    });
    result.current.mutate(true);
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
