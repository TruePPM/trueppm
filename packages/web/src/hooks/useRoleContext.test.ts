import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useUpdateRoleContext } from './useRoleContext';

const patchMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { role_context: 'pm' } }),
);

vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useUpdateRoleContext', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('PATCHes the profile endpoint with the new lens', async () => {
    const { result } = renderHook(() => useUpdateRoleContext(), { wrapper: makeWrapper(qc) });
    result.current.mutate('pm');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/auth/me/profile/', { role_context: 'pm' });
  });

  it('invalidates the current-user query on success so consumers re-read the lens', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateRoleContext(), { wrapper: makeWrapper(qc) });
    result.current.mutate('scrum_master');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['current-user'] });
  });

  it('surfaces the error (no invalidate) when the PATCH is rejected', async () => {
    patchMock.mockRejectedValueOnce(new Error('400'));
    const { result } = renderHook(() => useUpdateRoleContext(), { wrapper: makeWrapper(qc) });
    result.current.mutate('pm');
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
