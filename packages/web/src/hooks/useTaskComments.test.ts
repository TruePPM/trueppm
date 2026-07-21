import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useTaskComments,
  useCreateComment,
  useAcknowledgeComment,
  useReactToComment,
  useUpdateComment,
  useDeleteComment,
} from './useTaskComments';
import type { TaskComment } from '@/types';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, delete: deleteMock, patch: patchMock },
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { id: 'u1', username: 'alice', display_name: 'Alice', initials: 'A', email: 'a@x' },
    isLoading: false,
  }),
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

const baseComment: TaskComment = {
  id: 'c1',
  task: 't1',
  parent: null,
  author: { id: 'u1', username: 'alice', display_name: 'Alice' },
  body: 'first comment',
  edited_at: null,
  created_at: '2026-05-20T00:00:00Z',
  is_deleted: false,
  deleted_at: null,
  deleted_by: null,
  acknowledged_count: 0,
  reaction_count: 0,
  has_my_acknowledgement: false,
  has_my_reaction: false,
  my_reaction_id: null,
};

describe('useTaskComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the comment thread when both ids are present', async () => {
    getMock.mockResolvedValue({
      data: { count: 1, next: null, previous: null, results: [baseComment] },
    });
    const { result } = renderHook(() => useTaskComments('p1', 't1'), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/comments/');
    expect(result.current.comments).toHaveLength(1);
  });

  it('does not fetch when taskId is null (drawer closed)', () => {
    renderHook(() => useTaskComments('p1', null), {
      wrapper: makeWrapper(newQc()),
    });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useCreateComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs the comment body and parent=null by default', async () => {
    const qc = newQc();
    qc.setQueryData(['task-comments', 't1'], [baseComment]);
    postMock.mockResolvedValueOnce({
      data: { ...baseComment, id: 'c2', body: 'second' },
    });
    const { result } = renderHook(() => useCreateComment(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        body: 'second',
      });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/comments/', {
      body: 'second',
      parent: null,
    });
  });

  it('passes parent id for a one-level reply', async () => {
    postMock.mockResolvedValueOnce({ data: { ...baseComment, parent: 'c1' } });
    const { result } = renderHook(() => useCreateComment(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        body: 'reply',
        parentId: 'c1',
      });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/comments/', {
      body: 'reply',
      parent: 'c1',
    });
  });

  it('rolls back the optimistic append when the POST fails', async () => {
    const qc = newQc();
    qc.setQueryData(['task-comments', 't1'], [baseComment]);
    postMock.mockRejectedValueOnce(new Error('500'));
    const { result } = renderHook(() => useCreateComment(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      try {
        await result.current.mutateAsync({
          projectId: 'p1',
          taskId: 't1',
          body: 'will fail',
        });
      } catch {
        // expected
      }
    });
    const cached = qc.getQueryData<TaskComment[]>(['task-comments', 't1']);
    expect(cached).toEqual([baseComment]);
  });
});

describe('useUpdateComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PATCHes the comment body (#2171)', async () => {
    patchMock.mockResolvedValueOnce({ data: { ...baseComment, body: 'fixed' } });
    const { result } = renderHook(() => useUpdateComment(), { wrapper: makeWrapper(newQc()) });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        commentId: 'c1',
        body: 'fixed',
      });
    });
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/comments/c1/', { body: 'fixed' });
  });

  it('surfaces the error when the edit window has closed (#2171)', async () => {
    patchMock.mockRejectedValueOnce(new Error('comment_edit_window_closed'));
    const { result } = renderHook(() => useUpdateComment(), { wrapper: makeWrapper(newQc()) });
    await act(async () => {
      try {
        await result.current.mutateAsync({
          projectId: 'p1',
          taskId: 't1',
          commentId: 'c1',
          body: 'too late',
        });
      } catch {
        // expected
      }
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useDeleteComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DELETEs the comment (#2171)', async () => {
    deleteMock.mockResolvedValueOnce({ data: undefined });
    const { result } = renderHook(() => useDeleteComment(), { wrapper: makeWrapper(newQc()) });
    await act(async () => {
      await result.current.mutateAsync({ projectId: 'p1', taskId: 't1', commentId: 'c1' });
    });
    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/comments/c1/');
  });
});

describe('useAcknowledgeComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs when acknowledge is true', async () => {
    postMock.mockResolvedValueOnce({
      data: { id: 'ack1', user: baseComment.author!, created_at: '2026-05-20T00:00:00Z' },
    });
    const { result } = renderHook(() => useAcknowledgeComment(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        commentId: 'c1',
        acknowledge: true,
      });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/comments/c1/acknowledge/');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('DELETEs when acknowledge is false', async () => {
    deleteMock.mockResolvedValueOnce({ data: { deleted: 1 } });
    const { result } = renderHook(() => useAcknowledgeComment(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        commentId: 'c1',
        acknowledge: false,
      });
    });
    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/comments/c1/acknowledge/');
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('useReactToComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs a new reaction when reactionId is omitted', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        id: 'r1',
        user: baseComment.author!,
        emoji: '👍',
        created_at: '2026-05-20T00:00:00Z',
      },
    });
    const { result } = renderHook(() => useReactToComment(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        commentId: 'c1',
        emoji: '👍',
      });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/comments/c1/reactions/', {
      emoji: '👍',
    });
  });

  it('DELETEs an existing reaction when reactionId is provided', async () => {
    deleteMock.mockResolvedValueOnce({ data: undefined });
    const { result } = renderHook(() => useReactToComment(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        commentId: 'c1',
        emoji: '👍',
        reactionId: 'r1',
      });
    });
    expect(deleteMock).toHaveBeenCalledWith(
      '/projects/p1/tasks/t1/comments/c1/reactions/r1/',
    );
    expect(postMock).not.toHaveBeenCalled();
  });
});
