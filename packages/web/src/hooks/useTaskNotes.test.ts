import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useTaskNotes,
  useCreateNote,
  useUpdateNote,
  usePinNote,
  useDeleteNote,
} from './useTaskNotes';
import type { TaskNote } from '@/types';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
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

const baseNote: TaskNote = {
  id: 'n1',
  task: 't1',
  author: { id: 'u1', username: 'alice', display_name: 'Alice' },
  body: 'first note',
  pinned: false,
  decision: false,
  edited_at: null,
  created_at: '2026-05-20T00:00:00Z',
  is_deleted: false,
  deleted_at: null,
  deleted_by: null,
};

describe('useTaskNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the note list and maps the paginated results when both ids are present', async () => {
    getMock.mockResolvedValue({
      data: { count: 1, next: null, previous: null, results: [baseNote] },
    });
    const { result } = renderHook(() => useTaskNotes('p1', 't1'), {
      wrapper: makeWrapper(newQc()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/notes/');
    expect(result.current.notes).toHaveLength(1);
    expect(result.current.notes[0].body).toBe('first note');
  });

  it('does not fetch when taskId is null (drawer closed)', () => {
    renderHook(() => useTaskNotes('p1', null), {
      wrapper: makeWrapper(newQc()),
    });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useCreateNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs the correct URL and body', async () => {
    postMock.mockResolvedValueOnce({ data: { ...baseNote, id: 'n2', body: 'second' } });
    const { result } = renderHook(() => useCreateNote(), {
      wrapper: makeWrapper(newQc()),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        body: 'second',
      });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/notes/', {
      body: 'second',
    });
  });

  it('optimistically appends the note so it shows immediately', async () => {
    const qc = newQc();
    qc.setQueryData(['task-notes', 't1'], [baseNote]);
    // Hold the POST open so we can observe the optimistic cache before it settles.
    let resolvePost: (value: { data: TaskNote }) => void = () => {};
    postMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    const { result } = renderHook(() => useCreateNote(), {
      wrapper: makeWrapper(qc),
    });
    act(() => {
      result.current.mutate({ projectId: 'p1', taskId: 't1', body: 'optimistic body' });
    });
    await waitFor(() => {
      const cached = qc.getQueryData<TaskNote[]>(['task-notes', 't1']);
      expect(cached).toHaveLength(2);
    });
    const cached = qc.getQueryData<TaskNote[]>(['task-notes', 't1']);
    expect(cached?.[1].body).toBe('optimistic body');
    await act(async () => {
      resolvePost({ data: { ...baseNote, id: 'n2', body: 'optimistic body' } });
      // Flush the resolved POST's microtasks inside act so the settle is
      // captured (and the async callback has a real await for require-await).
      await Promise.resolve();
    });
  });

  it('rolls back the optimistic append when the POST fails (cache restored)', async () => {
    const qc = newQc();
    qc.setQueryData(['task-notes', 't1'], [baseNote]);
    postMock.mockRejectedValueOnce(new Error('500'));
    const { result } = renderHook(() => useCreateNote(), {
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
    const cached = qc.getQueryData<TaskNote[]>(['task-notes', 't1']);
    expect(cached).toEqual([baseNote]);
  });

  it('invalidates the notes query on success', async () => {
    const qc = newQc();
    qc.setQueryData(['task-notes', 't1'], [baseNote]);
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    postMock.mockResolvedValueOnce({ data: { ...baseNote, id: 'n2' } });
    const { result } = renderHook(() => useCreateNote(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({ projectId: 'p1', taskId: 't1', body: 'second' });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-notes', 't1'] });
  });
});

describe('useUpdateNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PATCHes the note URL with the new body and invalidates on success', async () => {
    const qc = newQc();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    patchMock.mockResolvedValueOnce({ data: { ...baseNote, body: 'edited' } });
    const { result } = renderHook(() => useUpdateNote(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        taskId: 't1',
        noteId: 'n1',
        body: 'edited',
      });
    });
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/notes/n1/', {
      body: 'edited',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-notes', 't1'] });
  });
});

describe('usePinNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs the pin URL and invalidates on success', async () => {
    const qc = newQc();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    postMock.mockResolvedValueOnce({ data: { ...baseNote, pinned: true } });
    const { result } = renderHook(() => usePinNote(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({ projectId: 'p1', taskId: 't1', noteId: 'n1' });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/notes/n1/pin/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-notes', 't1'] });
  });
});

describe('useDeleteNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DELETEs the note URL and invalidates on success', async () => {
    const qc = newQc();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    deleteMock.mockResolvedValueOnce({ data: undefined });
    const { result } = renderHook(() => useDeleteNote(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({ projectId: 'p1', taskId: 't1', noteId: 'n1' });
    });
    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/tasks/t1/notes/n1/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-notes', 't1'] });
  });
});
