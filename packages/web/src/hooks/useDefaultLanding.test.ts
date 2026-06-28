import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useUpdateDefaultLanding } from './useDefaultLanding';

/**
 * Hook-level coverage for the default-landing profile mutation (#1365): the
 * chosen value is PATCHed to /auth/me/profile/ and success invalidates
 * `['current-user']` so the resolved landing re-fetches (the new home applies on
 * the next `/` hit, so the hook deliberately does not navigate).
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

describe('useUpdateDefaultLanding', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newClient();
    vi.clearAllMocks();
  });

  it('PATCHes /auth/me/profile/ with the chosen default_landing', async () => {
    patchMock.mockResolvedValue({ data: { default_landing: 'my_work' } });
    const { result } = renderHook(() => useUpdateDefaultLanding(), { wrapper: makeWrapper(qc) });
    result.current.mutate('my_work');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/auth/me/profile/', { default_landing: 'my_work' });
  });

  it('invalidates current-user so the resolved landing re-fetches', async () => {
    patchMock.mockResolvedValue({ data: { default_landing: 'portfolio' } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateDefaultLanding(), { wrapper: makeWrapper(qc) });
    result.current.mutate('portfolio');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['current-user'] });
  });
});
