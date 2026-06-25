/**
 * usePoker unit tests (#784 coverage backfill, ADR-0179, issue 863).
 *
 * The planning-poker hooks drive a multi-mutation lifecycle (open → vote → reveal →
 * reopen / commit / cancel). The branches that carry real UI consequences and must not
 * silently regress are:
 *  - the request body shape each lifecycle endpoint depends on (task / value+comment / points);
 *  - the `['poker', sprintId]` invalidation that converges every participant's screen;
 *  - the optimistic vote: the caller's own card flips before the server responds, and the
 *    pre-vote snapshot is restored on error;
 *  - commit's extra `['sprint-backlog']` invalidate (the committed points land on the task).
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { PokerSession } from '@/types';
import {
  pokerKey,
  useSprintPoker,
  useOpenPoker,
  useCastVote,
  useRevealPoker,
  useReopenPoker,
  useCancelPoker,
  useCommitPoker,
} from './usePoker';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock },
}));

function makeSession(overrides: Partial<PokerSession> = {}): PokerSession {
  return {
    id: 's1',
    task: { id: 't1', name: 'Story' },
    state: 'open',
    committed_points: null,
    started_by: null,
    started_at: '2026-06-25T00:00:00Z',
    my_vote: null,
    vote_count: 0,
    participant_count: 0,
    votes: [],
    ...overrides,
  };
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue({ data: [] });
  postMock.mockResolvedValue({ data: makeSession() });
});

describe('useSprintPoker', () => {
  it('reads the sprint rounds and exposes them as `sessions`', async () => {
    const rows = [makeSession({ id: 'a' }), makeSession({ id: 'b' })];
    getMock.mockResolvedValueOnce({ data: rows });
    const qc = makeQC();
    const { result } = renderHook(() => useSprintPoker('sp1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp1/poker/');
    expect(result.current.sessions).toEqual(rows);
  });

  it('does not fetch while the sprintId is null (gated query)', () => {
    const qc = makeQC();
    const { result } = renderHook(() => useSprintPoker(null), { wrapper: makeWrapper(qc) });

    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.sessions).toEqual([]);
  });

  it('does not fetch when `enabled` is false even with a real sprintId', () => {
    const qc = makeQC();
    renderHook(() => useSprintPoker('sp1', false), { wrapper: makeWrapper(qc) });

    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useOpenPoker', () => {
  it('posts { task } to the sprint poker endpoint', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useOpenPoker(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ sprintId: 'sp1', taskId: 't9' });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/sprints/sp1/poker/', { task: 't9' });
  });

  it('invalidates the sprint poker query on success', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useOpenPoker(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ sprintId: 'sp1', taskId: 't9' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: pokerKey('sp1') });
  });
});

describe('useCastVote', () => {
  it('posts { value, comment } to the vote endpoint, defaulting comment to ""', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useCastVote(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ sprintId: 'sp1', sessionId: 's1', value: 5 });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/poker/s1/vote/', { value: 5, comment: '' });
  });

  it('passes an explicit comment through verbatim', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useCastVote(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ sprintId: 'sp1', sessionId: 's1', value: 8, comment: 'risky' });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/poker/s1/vote/', { value: 8, comment: 'risky' });
  });

  it('optimistically flips the caller’s own card before the server responds', async () => {
    // Never-resolving POST proves the cache reflects the vote BEFORE the server replies.
    postMock.mockReturnValueOnce(new Promise(() => {}));
    const qc = makeQC();
    qc.setQueryData<PokerSession[]>(pokerKey('sp1'), [
      makeSession({ id: 's1', my_vote: null }),
      makeSession({ id: 's2', my_vote: null }),
    ]);
    const { result } = renderHook(() => useCastVote(), { wrapper: makeWrapper(qc) });

    act(() => {
      result.current.mutate({ sprintId: 'sp1', sessionId: 's1', value: 13, comment: 'big' });
    });

    await waitFor(() => {
      const cached = qc.getQueryData<PokerSession[]>(pokerKey('sp1'));
      expect(cached?.[0].my_vote).toEqual({ value: 13, comment: 'big' });
    });
    // Only the targeted session's card flips; the sibling row is untouched.
    const cached = qc.getQueryData<PokerSession[]>(pokerKey('sp1'));
    expect(cached?.[1].my_vote).toBeNull();
  });

  it('rolls the optimistic vote back to the pre-vote snapshot on error', async () => {
    postMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    const snapshot = [makeSession({ id: 's1', my_vote: null })];
    qc.setQueryData<PokerSession[]>(pokerKey('sp1'), snapshot);
    const { result } = renderHook(() => useCastVote(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ sprintId: 'sp1', sessionId: 's1', value: 3 });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<PokerSession[]>(pokerKey('sp1'));
    expect(cached?.[0].my_vote).toBeNull();
  });

  it('invalidates on settle so every participant converges on the server row', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCastVote(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ sprintId: 'sp1', sessionId: 's1', value: 5 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: pokerKey('sp1') });
  });

  it('still invalidates on settle after a failed vote (rollback + refetch)', async () => {
    postMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCastVote(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ sprintId: 'sp1', sessionId: 's1', value: 5 });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: pokerKey('sp1') });
  });
});

describe('session actions (reveal / reopen / cancel)', () => {
  const cases: Array<['reveal' | 'reopen' | 'cancel', () => ReturnType<typeof useRevealPoker>]> = [
    ['reveal', useRevealPoker],
    ['reopen', useReopenPoker],
    ['cancel', useCancelPoker],
  ];

  it.each(cases)('use%sPoker posts to /poker/{id}/%s/ and invalidates', async (action, hook) => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => hook(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ sprintId: 'sp1', sessionId: 's1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith(`/poker/s1/${action}/`);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: pokerKey('sp1') });
  });
});

describe('useCommitPoker', () => {
  it('posts the agreed { points } to the commit endpoint', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useCommitPoker(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ sprintId: 'sp1', sessionId: 's1', points: 5 });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/poker/s1/commit/', { points: 5 });
  });

  it('invalidates BOTH the poker round and the sprint backlog on success', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCommitPoker(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ sprintId: 'sp1', sessionId: 's1', points: 5 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The committed story_points lands on the task → both the round and the planning backlog refresh.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: pokerKey('sp1') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprint-backlog'] });
  });
});
