import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useOidcProvider,
  useUpdateOidcProvider,
  useDeleteOidcProvider,
  useTestOidcConnection,
} from './useSso';
import type { OidcProviderConfig } from './useSso';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const getMock = vi.hoisted(() => vi.fn());
const putMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock('@/api', () => ({
  apiClient: { get: getMock, put: putMock, post: postMock, delete: deleteMock },
}));

const PROVIDER: OidcProviderConfig = {
  enabled: true,
  display_name: 'Keycloak',
  issuer_url: 'https://idp.example.com/realms/main',
  client_id: 'trueppm',
  scopes: ['openid', 'email', 'profile'],
  allowed_email_domains: ['example.com'],
  auto_create_members: true,
  default_role: 4,
  allow_password_signin: true,
  allow_password_signin_enforced: false,
  secret_set: true,
  redirect_uri: 'https://app.example.com/api/v1/auth/oidc/callback/',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-10T00:00:00Z',
};

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

// ---------------------------------------------------------------------------
// useOidcProvider
// ---------------------------------------------------------------------------

describe('useOidcProvider', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('fetches the singleton provider config', async () => {
    getMock.mockResolvedValueOnce({ data: PROVIDER });

    const { result } = renderHook(() => useOidcProvider(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/workspace/sso/');
    expect(result.current.data).toEqual(PROVIDER);
  });

  it('surfaces the error without retrying', async () => {
    getMock.mockRejectedValueOnce(new Error('not configured'));

    const { result } = renderHook(() => useOidcProvider(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(getMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useUpdateOidcProvider
// ---------------------------------------------------------------------------

describe('useUpdateOidcProvider', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('PUTs the partial body to the singleton endpoint', async () => {
    putMock.mockResolvedValueOnce({ data: PROVIDER });

    const { result } = renderHook(() => useUpdateOidcProvider(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ display_name: 'Keycloak', client_secret: 's3cret' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(putMock).toHaveBeenCalledWith('/workspace/sso/', {
      display_name: 'Keycloak',
      client_secret: 's3cret',
    });
  });

  it('seeds the cache with the response and invalidates on success', async () => {
    putMock.mockResolvedValueOnce({ data: PROVIDER });
    const setDataSpy = vi.spyOn(qc, 'setQueryData');
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateOidcProvider(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ enabled: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(setDataSpy).toHaveBeenCalledWith(['workspace-sso-provider'], PROVIDER);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspace-sso-provider'] });
  });
});

// ---------------------------------------------------------------------------
// useDeleteOidcProvider
// ---------------------------------------------------------------------------

describe('useDeleteOidcProvider', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('DELETEs the singleton endpoint and invalidates the provider query', async () => {
    deleteMock.mockResolvedValueOnce({});
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteOidcProvider(), { wrapper: makeWrapper(qc) });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(deleteMock).toHaveBeenCalledWith('/workspace/sso/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspace-sso-provider'] });
  });
});

// ---------------------------------------------------------------------------
// useTestOidcConnection
// ---------------------------------------------------------------------------

describe('useTestOidcConnection', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('POSTs an empty body when called without vars', async () => {
    postMock.mockResolvedValueOnce({ data: { ok: true, issuer: PROVIDER.issuer_url } });

    const { result } = renderHook(() => useTestOidcConnection(), { wrapper: makeWrapper(qc) });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/workspace/sso/test-connection/', {});
    expect(result.current.data?.ok).toBe(true);
  });

  it('POSTs the supplied issuer_url override', async () => {
    postMock.mockResolvedValueOnce({ data: { ok: true } });

    const { result } = renderHook(() => useTestOidcConnection(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ issuer_url: 'https://other.example.com' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/workspace/sso/test-connection/', {
      issuer_url: 'https://other.example.com',
    });
  });

  it('normalizes a rejected response carrying an ok body into a result', async () => {
    postMock.mockRejectedValueOnce({
      response: { data: { ok: false, error: 'discovery_unreachable', detail: 'timeout' } },
    });

    const { result } = renderHook(() => useTestOidcConnection(), { wrapper: makeWrapper(qc) });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({
      ok: false,
      error: 'discovery_unreachable',
      detail: 'timeout',
    });
  });

  it('rethrows errors without a structured ok body', async () => {
    postMock.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useTestOidcConnection(), { wrapper: makeWrapper(qc) });

    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe('network down');
  });
});
