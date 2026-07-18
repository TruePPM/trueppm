import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useSsoProviders,
  useCreateSsoProvider,
  useUpdateSsoProvider,
  useDeleteSsoProvider,
  useTestSsoConnection,
} from './useSso';
import type { SsoProvider } from './useSso';

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

const KEYCLOAK: SsoProvider = {
  slug: 'keycloak',
  provider: 'openid_connect',
  kind: 'derived',
  display_name: 'Keycloak',
  enabled: true,
  client_id: 'trueppm',
  server_url: 'https://idp.example.com/realms/main',
  github_org: '',
  scopes: ['openid', 'email', 'profile'],
  allowed_email_domains: ['example.com'],
  auto_create_members: true,
  default_role: 100,
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

function freshClient(kind: 'queries' | 'mutations') {
  return new QueryClient({ defaultOptions: { [kind]: { retry: false } } });
}

// ---------------------------------------------------------------------------
// useSsoProviders
// ---------------------------------------------------------------------------

describe('useSsoProviders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GETs the provider collection', async () => {
    getMock.mockResolvedValueOnce({ data: [KEYCLOAK] });
    const { result } = renderHook(() => useSsoProviders(), {
      wrapper: makeWrapper(freshClient('queries')),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/workspace/sso/providers/');
    expect(result.current.data).toEqual([KEYCLOAK]);
  });

  it('surfaces the error without retrying', async () => {
    getMock.mockRejectedValueOnce(new Error('forbidden'));
    const { result } = renderHook(() => useSsoProviders(), {
      wrapper: makeWrapper(freshClient('queries')),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useCreateSsoProvider
// ---------------------------------------------------------------------------

describe('useCreateSsoProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs the body to the collection and invalidates the list', async () => {
    postMock.mockResolvedValueOnce({ data: KEYCLOAK });
    const qc = freshClient('mutations');
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateSsoProvider(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ slug: 'keycloak', client_id: 'trueppm', client_secret: 's3cret' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/workspace/sso/providers/', {
      slug: 'keycloak',
      client_id: 'trueppm',
      client_secret: 's3cret',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspace-sso-providers'] });
  });
});

// ---------------------------------------------------------------------------
// useUpdateSsoProvider
// ---------------------------------------------------------------------------

describe('useUpdateSsoProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PUTs to the slug item URL and invalidates the list', async () => {
    putMock.mockResolvedValueOnce({ data: KEYCLOAK });
    const qc = freshClient('mutations');
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateSsoProvider(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ slug: 'keycloak', body: { display_name: 'KC' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(putMock).toHaveBeenCalledWith('/workspace/sso/providers/keycloak/', {
      display_name: 'KC',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspace-sso-providers'] });
  });
});

// ---------------------------------------------------------------------------
// useDeleteSsoProvider
// ---------------------------------------------------------------------------

describe('useDeleteSsoProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('DELETEs the slug item URL and invalidates the list', async () => {
    deleteMock.mockResolvedValueOnce({});
    const qc = freshClient('mutations');
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteSsoProvider(), { wrapper: makeWrapper(qc) });
    result.current.mutate('keycloak');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(deleteMock).toHaveBeenCalledWith('/workspace/sso/providers/keycloak/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspace-sso-providers'] });
  });
});

// ---------------------------------------------------------------------------
// useTestSsoConnection
// ---------------------------------------------------------------------------

describe('useTestSsoConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs an empty body to the slug test-connection URL', async () => {
    postMock.mockResolvedValueOnce({ data: { ok: true, issuer: KEYCLOAK.server_url } });

    const { result } = renderHook(() => useTestSsoConnection(), {
      wrapper: makeWrapper(freshClient('mutations')),
    });
    result.current.mutate('keycloak');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith(
      '/workspace/sso/providers/keycloak/test-connection/',
      {},
    );
    expect(result.current.data?.ok).toBe(true);
  });

  it('normalizes a rejected response carrying an ok body into a result', async () => {
    postMock.mockRejectedValueOnce({
      response: { data: { ok: false, error: 'discovery_unreachable', detail: 'timeout' } },
    });

    const { result } = renderHook(() => useTestSsoConnection(), {
      wrapper: makeWrapper(freshClient('mutations')),
    });
    result.current.mutate('keycloak');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({
      ok: false,
      error: 'discovery_unreachable',
      detail: 'timeout',
    });
  });

  it('rethrows errors without a structured ok body', async () => {
    postMock.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useTestSsoConnection(), {
      wrapper: makeWrapper(freshClient('mutations')),
    });
    result.current.mutate('keycloak');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('network down');
  });
});
