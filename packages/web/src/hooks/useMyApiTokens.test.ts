import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  isTokenActive,
  useMyApiTokens,
  useCreateMyApiToken,
  useRevokeMyApiToken,
  type MyApiToken,
} from './useMyApiTokens';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, delete: deleteMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function token(overrides: Partial<MyApiToken> = {}): MyApiToken {
  return {
    id: 't1',
    name: 'Export',
    token_prefix: 'tppm_abc',
    scopes: ['legacy:full'],
    created_at: '2026-06-01T00:00:00Z',
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    is_revoked: false,
    is_expired: false,
    ...overrides,
  };
}

describe('useMyApiTokens', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('unwraps the paginated results array', async () => {
    getMock.mockResolvedValueOnce({ data: { count: 1, next: null, previous: null, results: [token()] } });
    const { result } = renderHook(() => useMyApiTokens(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/me/api-tokens/');
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].name).toBe('Export');
  });

  it('create posts name + expiry and returns the one-time raw token', async () => {
    postMock.mockResolvedValueOnce({ data: { ...token(), token: 'tppm_rawsecret' } });
    const { result } = renderHook(() => useCreateMyApiToken(), { wrapper: makeWrapper(qc) });
    let created: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => {
      created = await result.current.mutateAsync({ name: 'CI', expires_at: '2026-12-31T23:59:59Z' });
    });
    expect(postMock).toHaveBeenCalledWith('/me/api-tokens/', {
      name: 'CI',
      expires_at: '2026-12-31T23:59:59Z',
    });
    expect(created?.token).toBe('tppm_rawsecret');
  });

  it('revoke deletes by id', async () => {
    deleteMock.mockResolvedValueOnce({ data: undefined });
    const { result } = renderHook(() => useRevokeMyApiToken(), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync('t9');
    });
    expect(deleteMock).toHaveBeenCalledWith('/me/api-tokens/t9/');
  });
});

describe('isTokenActive', () => {
  it('is true for a live token, false when revoked or expired', () => {
    expect(isTokenActive(token())).toBe(true);
    expect(isTokenActive(token({ is_revoked: true, revoked_at: '2026-06-02T00:00:00Z' }))).toBe(
      false,
    );
    expect(isTokenActive(token({ is_expired: true }))).toBe(false);
  });
});
