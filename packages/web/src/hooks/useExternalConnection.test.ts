import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useExternalConnection,
  type ExternalConnectionSummary,
} from './useExternalConnection';

const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
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
};

beforeEach(() => {
  getMock.mockReset();
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
