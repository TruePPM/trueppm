import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  return { ...actual, default: { ...actual.default, get: getMock } };
});

import { useDemoMode } from './useDemoMode';
import { useEdition } from './useEdition';

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useDemoMode', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('reads a server that omits the fields as "not a demo"', async () => {
    getMock.mockResolvedValue({ data: { edition: 'community' } });
    const { result } = renderHook(() => useDemoMode(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isDemoReadOnly).toBe(false);
    expect(result.current.loginHint).toBeNull();
    expect(result.current.resetSchedule).toBeNull();
  });

  it('surfaces the reset schedule when present (#4152)', async () => {
    getMock.mockResolvedValue({
      data: { edition: 'community', demo_read_only: true, demo_reset_schedule: '0 8 * * *' },
    });
    const { result } = renderHook(() => useDemoMode(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.isDemoReadOnly).toBe(true));
    expect(result.current.resetSchedule).toBe('0 8 * * *');
  });

  it('reads a null reset schedule (reset disabled) without inventing one', async () => {
    getMock.mockResolvedValue({
      data: { edition: 'community', demo_read_only: true, demo_reset_schedule: null },
    });
    const { result } = renderHook(() => useDemoMode(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.isDemoReadOnly).toBe(true));
    expect(result.current.resetSchedule).toBeNull();
  });

  it('surfaces the mode and the published credential when present', async () => {
    getMock.mockResolvedValue({
      data: {
        edition: 'community',
        demo_read_only: true,
        demo_login_hint: { username: 'demo@trueppm.com', password: 'trueppm-demo' },
      },
    });
    const { result } = renderHook(() => useDemoMode(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.isDemoReadOnly).toBe(true));
    expect(result.current.loginHint).toEqual({
      username: 'demo@trueppm.com',
      password: 'trueppm-demo',
    });
  });

  it('reads demo_read_only true with a null hint without inventing one', async () => {
    getMock.mockResolvedValue({
      data: { edition: 'community', demo_read_only: true, demo_login_hint: null },
    });
    const { result } = renderHook(() => useDemoMode(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.isDemoReadOnly).toBe(true));
    expect(result.current.loginHint).toBeNull();
  });

  it('shares one request with useEdition', async () => {
    // The regression the shared `editionQueryOptions` exists to prevent: three
    // hand-copied queryFns turn one cache entry into two network calls.
    getMock.mockResolvedValue({ data: { edition: 'enterprise', demo_read_only: false } });
    const qc = newClient();
    const { result } = renderHook(() => ({ demo: useDemoMode(), edition: useEdition() }), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.edition.isLoading).toBe(false));
    expect(result.current.edition.edition).toBe('enterprise');
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
