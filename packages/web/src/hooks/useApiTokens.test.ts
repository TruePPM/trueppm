import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useApiTokens, useCreateApiToken, useRevokeApiToken, type ApiToken } from './useApiTokens';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('@/api', () => ({ apiClient: { get: getMock, post: postMock, delete: deleteMock } }));

const TOKEN: ApiToken = {
  id: 'tk1',
  project: 'p1',
  program: null,
  name: 'CI',
  token_prefix: 'tppm_ab',
  status_map: {},
  scopes: ['legacy:full'],
  created_by: null,
  created_at: '2026-04-01T00:00:00Z',
  last_used_at: null,
  revoked_at: null,
  is_revoked: false,
};

let qc: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  [getMock, postMock, deleteMock].forEach((m) => m.mockReset());
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
});

describe('useApiTokens', () => {
  it('lists tokens off the pluralized scope path and unwraps the page', async () => {
    getMock.mockResolvedValue({ data: { count: 1, next: null, previous: null, results: [TOKEN] } });
    const { result } = renderHook(() => useApiTokens({ kind: 'program', id: 'pg1' }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([TOKEN]));
    expect(getMock).toHaveBeenCalledWith('/programs/pg1/api-tokens/');
  });

  it('is idle without a scope or without an id', () => {
    const { result } = renderHook(() => useApiTokens(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    const { result: blank } = renderHook(() => useApiTokens({ kind: 'project', id: '' }), {
      wrapper,
    });
    expect(blank.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('token mutations', () => {
  it('create returns the one-time raw token and refreshes the list', async () => {
    postMock.mockResolvedValue({ data: { ...TOKEN, token: 'tppm_ab_secret' } });
    const { result } = renderHook(() => useCreateApiToken({ kind: 'project', id: 'p1' }), {
      wrapper,
    });
    let created: { token: string } | undefined;
    await act(async () => {
      created = await result.current.mutateAsync({ name: 'CI', scopes: ['mcp:read'] });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/api-tokens/', {
      name: 'CI',
      scopes: ['mcp:read'],
    });
    expect(created?.token).toBe('tppm_ab_secret');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['api-tokens', 'project', 'p1'] });
  });

  it('revoke deletes by id and refreshes the list', async () => {
    deleteMock.mockResolvedValue({});
    const { result } = renderHook(() => useRevokeApiToken({ kind: 'project', id: 'p1' }), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync('tk1');
    });
    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/api-tokens/tk1/');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['api-tokens', 'project', 'p1'] });
  });
});
