import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useTaskAttachments,
  useCreateAttachment,
  useDeleteAttachment,
  useSignedDownloadUrl,
  MAX_ATTACHMENT_SIZE_BYTES,
  isMimeAllowed,
  normalizeMime,
} from './useTaskAttachments';
import type { TaskAttachment } from '@/types';

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

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const baseAttachment: TaskAttachment = {
  id: 'a1',
  file: 'attachments/a1.pdf',
  file_name: 'spec.pdf',
  file_size: 1234,
  file_mime: 'application/pdf',
  external_url: '',
  external_title: '',
  is_pinned: false,
  uploaded_by: { id: 'u1', username: 'alice', display_name: 'Alice' },
  deleted_by: null,
  created_at: '2026-05-20T00:00:00Z',
  is_deleted: false,
  deleted_at: null,
};

describe('locked size cap', () => {
  it('matches the server-side cap', () => {
    expect(MAX_ATTACHMENT_SIZE_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe('isMimeAllowed / normalizeMime (ADR-0153)', () => {
  const allowed = ['application/pdf', 'text/csv'];

  it('normalizes a MIME by dropping the charset suffix and lowercasing', () => {
    expect(normalizeMime('TEXT/CSV; charset=utf-8')).toBe('text/csv');
    expect(normalizeMime('  application/pdf  ')).toBe('application/pdf');
    expect(normalizeMime('')).toBe('');
  });

  it('allows a MIME present in the resolved list (after normalization)', () => {
    expect(isMimeAllowed('application/pdf', allowed)).toBe(true);
    expect(isMimeAllowed('text/csv; charset=utf-8', allowed)).toBe(true);
  });

  it('rejects a MIME absent from the resolved list', () => {
    expect(isMimeAllowed('image/gif', allowed)).toBe(false);
    // An empty resolved list allows nothing.
    expect(isMimeAllowed('application/pdf', [])).toBe(false);
  });
});

describe('useTaskAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the attachment list when ids are present', async () => {
    getMock.mockResolvedValue({
      data: { count: 1, next: null, previous: null, results: [baseAttachment] },
    });
    const { result } = renderHook(() => useTaskAttachments('p1', 't1'), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/attachments/');
    expect(result.current.attachments).toEqual([baseAttachment]);
  });

  it('does not fetch when taskId is null', () => {
    renderHook(() => useTaskAttachments('p1', null), {
      wrapper: makeWrapper(newQc()),
    });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useCreateAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs multipart for a file upload', async () => {
    postMock.mockResolvedValueOnce({ data: baseAttachment });
    const file = new File(['hello'], 'spec.pdf', { type: 'application/pdf' });
    const { result } = renderHook(() => useCreateAttachment(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({ projectId: 'p1', taskId: 't1', file });
    });
    const call = postMock.mock.calls[0] as [string, unknown, unknown];
    expect(call[0]).toBe('/projects/p1/tasks/t1/attachments/');
    expect(call[1]).toBeInstanceOf(FormData);
    expect((call[1] as FormData).get('file')).toBeInstanceOf(File);
    expect(call[2]).toEqual({ headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 });
  });

  it('POSTs JSON for an external link with explicit title', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        ...baseAttachment,
        file: '',
        external_url: 'https://docs.google.com/x',
        external_title: 'Design doc',
      },
    });
    const { result } = renderHook(() => useCreateAttachment(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        externalUrl: 'https://docs.google.com/x',
        externalTitle: 'Design doc',
      });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/attachments/', {
      external_url: 'https://docs.google.com/x',
      external_title: 'Design doc',
    });
  });

  it('defaults the external title to an empty string when omitted', async () => {
    postMock.mockResolvedValueOnce({ data: baseAttachment });
    const { result } = renderHook(() => useCreateAttachment(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        externalUrl: 'https://example.com',
      });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/attachments/', {
      external_url: 'https://example.com',
      external_title: '',
    });
  });
});

describe('useDeleteAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DELETEs the attachment and invalidates the list cache', async () => {
    const qc = newQc();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    deleteMock.mockResolvedValueOnce({ data: undefined });
    const { result } = renderHook(() => useDeleteAttachment(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        attachmentId: 'a1',
      });
    });
    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/attachments/a1/');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task-attachments', 't1'] });
  });
});

describe('useSignedDownloadUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits the ttl param when no override is provided', async () => {
    getMock.mockResolvedValueOnce({
      data: { url: 'https://signed.example/a', expires_at: '2026-05-20T00:15:00Z' },
    });
    const { result } = renderHook(() => useSignedDownloadUrl(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      const res = await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        attachmentId: 'a1',
      });
      expect(res.url).toContain('https://');
    });
    expect(getMock).toHaveBeenCalledWith(
      '/projects/p1/tasks/t1/attachments/a1/signed-url/',
      undefined,
    );
  });

  it('passes the ttl override as a query param', async () => {
    getMock.mockResolvedValueOnce({
      data: { url: 'https://signed.example/b', expires_at: '2026-05-20T00:30:00Z' },
    });
    const { result } = renderHook(() => useSignedDownloadUrl(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        attachmentId: 'a1',
        ttl: 1800,
      });
    });
    expect(getMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/attachments/a1/signed-url/', {
      params: { ttl: 1800 },
    });
  });
});
