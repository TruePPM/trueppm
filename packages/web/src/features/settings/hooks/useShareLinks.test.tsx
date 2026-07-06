import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useCreateShareLink,
  useRevokeShareLink,
  useShareLinks,
  type CreatedShareLink,
  type ShareLink,
} from './useShareLinks';

const postMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ apiClient: { post: postMock, get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function rawLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    content_kind: 'board',
    token_prefix: 'sample-pfx-1',
    label: 'Client board',
    show_assignees: false,
    created_by: 'Kelly',
    created_at: '2026-07-06T00:00:00Z',
    revoked_at: null,
    access_count: 3,
    last_accessed_at: '2026-07-06T01:00:00Z',
    is_active: true,
    ...overrides,
  };
}

describe('useShareLinks', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('GETs the list and maps snake_case → camelCase', async () => {
    getMock.mockResolvedValueOnce({ data: [rawLink()] });
    const { result } = renderHook(() => useShareLinks('proj-1'), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    });
    const link = (result.current.data as ShareLink[])[0];
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/share-links/');
    expect(link.tokenPrefix).toBe('sample-pfx-1');
    expect(link.accessCount).toBe(3);
    expect(link.showAssignees).toBe(false);
  });
});

describe('useCreateShareLink', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('POSTs label + show_assignees and returns the one-time token + path', async () => {
    postMock.mockResolvedValueOnce({
      data: rawLink({ token: 'RAWTOKEN', share_path: '/share/board/RAWTOKEN' }),
    });
    const { result } = renderHook(() => useCreateShareLink('proj-1'), { wrapper: makeWrapper(qc) });
    let created: CreatedShareLink | undefined;
    await act(async () => {
      created = await result.current.mutateAsync({ label: 'X', showAssignees: true });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/share-links/', {
      label: 'X',
      show_assignees: true,
      content_kind: 'board',
      expires_at: null,
    });
    expect(created?.token).toBe('RAWTOKEN');
    expect(created?.sharePath).toBe('/share/board/RAWTOKEN');
  });
});

describe('useRevokeShareLink', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('POSTs to the revoke endpoint', async () => {
    postMock.mockResolvedValueOnce({ data: {} });
    const { result } = renderHook(() => useRevokeShareLink('proj-1'), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync('link-9');
    });
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/share-links/link-9/revoke/');
  });
});
