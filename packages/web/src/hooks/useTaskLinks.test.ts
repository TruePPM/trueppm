/**
 * useTaskLinks unit tests (#784 coverage backfill, ADR-0049 §3 / #637).
 *
 * The git-aware task-link hooks carry logic a stale regression would silently
 * corrupt:
 *  - linkDisplayTitle resolves the #970 display precedence custom_title → title → url;
 *  - useTaskLinks gates the fetch on both ids and defaults the list to [] so callers
 *    never read undefined;
 *  - the create/update/delete/refresh mutations each invalidate the per-task links
 *    key so the section re-derives, send only the keys they were given, and the
 *    refresh surfaces the 422 credential_required rejection to the caller verbatim.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  linkDisplayTitle,
  useTaskLinks,
  useCreateTaskLink,
  useUpdateTaskLink,
  useDeleteTaskLink,
  useRefreshTaskLink,
  type TaskExternalLink,
} from './useTaskLinks';

const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function link(overrides: Partial<TaskExternalLink> = {}): TaskExternalLink {
  return {
    id: 'l1',
    url: 'https://gitlab.com/x/y/-/merge_requests/3',
    provider: 'gitlab',
    title: '',
    custom_title: '',
    labels: [],
    status: 'unknown',
    fetched_at: null,
    description: '',
    thumbnail_url: '',
    preview_type: '',
    display_order: 0,
    server_version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('linkDisplayTitle (#970 precedence)', () => {
  it('prefers the user-supplied custom_title above all', () => {
    expect(
      linkDisplayTitle(link({ custom_title: 'My MR', title: 'Provider title' })),
    ).toBe('My MR');
  });

  it('falls back to the provider title when no custom_title is set', () => {
    expect(linkDisplayTitle(link({ custom_title: '', title: 'Provider title' }))).toBe(
      'Provider title',
    );
  });

  it('falls back to the raw url when neither title is set', () => {
    const l = link({ custom_title: '', title: '' });
    expect(linkDisplayTitle(l)).toBe(l.url);
  });
});

describe('useTaskLinks', () => {
  it('fetches the link list and exposes it', async () => {
    getMock.mockResolvedValueOnce({ data: [link({ id: 'l1' }), link({ id: 'l2' })] });
    const qc = makeQC();
    const { result } = renderHook(() => useTaskLinks('p1', 't1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/links/');
    expect(result.current.links.map((l) => l.id)).toEqual(['l1', 'l2']);
  });

  it('defaults links to [] before any data arrives (callers never read undefined)', () => {
    getMock.mockReturnValueOnce(new Promise(() => {}));
    const qc = makeQC();
    const { result } = renderHook(() => useTaskLinks('p1', 't1'), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current.links).toEqual([]);
  });

  it('does not fetch when the taskId is null (enabled gate)', () => {
    const qc = makeQC();
    renderHook(() => useTaskLinks('p1', null), { wrapper: makeWrapper(qc) });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useCreateTaskLink', () => {
  it('posts the body with custom_title/labels defaulted and invalidates the links key', async () => {
    postMock.mockResolvedValueOnce({ data: link({ id: 'new' }) });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateTaskLink(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', url: 'https://example.com' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/links/', {
      url: 'https://example.com',
      custom_title: '',
      labels: [],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-links', 't1'] });
  });
});

describe('useUpdateTaskLink', () => {
  it('sends only the fields it was given (omits undefined keys)', async () => {
    patchMock.mockResolvedValueOnce({ data: link({ custom_title: 'Renamed' }) });
    const qc = makeQC();
    const { result } = renderHook(() => useUpdateTaskLink(), { wrapper: makeWrapper(qc) });

    result.current.mutate({
      projectId: 'p1',
      taskId: 't1',
      linkId: 'l1',
      customTitle: 'Renamed',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/links/l1/', {
      custom_title: 'Renamed',
    });
  });

  it('invalidates the links key after a successful edit', async () => {
    patchMock.mockResolvedValueOnce({ data: link({ labels: ['infra'] }) });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateTaskLink(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', linkId: 'l1', labels: ['infra'] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/links/l1/', {
      labels: ['infra'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-links', 't1'] });
  });
});

describe('useDeleteTaskLink', () => {
  it('deletes the link and invalidates the links key', async () => {
    deleteMock.mockResolvedValueOnce(undefined);
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteTaskLink(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', linkId: 'l1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/links/l1/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-links', 't1'] });
  });
});

describe('useRefreshTaskLink', () => {
  it('refreshes the link and invalidates the links key on success', async () => {
    postMock.mockResolvedValueOnce({ data: link({ status: 'open', title: 'Fetched' }) });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRefreshTaskLink(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', linkId: 'l1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/links/l1/refresh/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-links', 't1'] });
  });

  it('surfaces the 422 credential_required rejection to the caller verbatim', async () => {
    // The component inspects error.response.data.code to show a Connect affordance,
    // so the rejection must bubble unchanged rather than being swallowed.
    const err = Object.assign(new Error('Unprocessable'), {
      response: { status: 422, data: { code: 'credential_required', provider: 'github' } },
    });
    postMock.mockRejectedValueOnce(err);
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRefreshTaskLink(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', linkId: 'l1' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(
      (result.current.error as { response?: { data?: { code?: string } } })?.response?.data
        ?.code,
    ).toBe('credential_required');
    // A failed refresh must not invalidate (no cache change to re-derive).
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
