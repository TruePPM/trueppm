/**
 * Tests for the risks hooks (#784 backfill).
 *
 * `useRisks` is a thin read, but `useCreateRiskComment` carries the real logic:
 * an optimistic append (ADR-0044) so the author sees their note instantly, with
 * a rollback to the pre-mutation list on error and an invalidation on settle.
 * Those three branches — append, rollback, invalidate — are the contract under
 * test; a regression here silently double-renders or strands optimistic rows.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useRisks, useCreateRiskComment } from './useRisks';
import type { Risk, RiskComment } from '@/api/types';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock } }));

// The optimistic comment author is sourced from the current user; pin it so the
// optimistic row is deterministic.
vi.mock('./useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { id: 'u1', display_name: 'Alice' } }),
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const existingComment: RiskComment = {
  id: 'c1',
  author: { id: 'u2', display_name: 'Bob' },
  message: 'first',
  created_at: '2026-06-01T00:00:00Z',
};

const RISK: Risk = {
  id: 'risk-1',
  // The read test only asserts identity passthrough; cast the minimal shape.
} as unknown as Risk;

describe('useRisks', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('does not fetch when projectId is null', () => {
    const { result } = renderHook(() => useRisks(null), {
      wrapper: makeWrapper(freshClient()),
    });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.risks).toEqual([]);
  });

  it('returns the paginated risk results for a project', async () => {
    getMock.mockResolvedValue({ data: { count: 1, next: null, previous: null, results: [RISK] } });
    const { result } = renderHook(() => useRisks('proj-1'), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.risks).toEqual([RISK]);
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/risks/');
  });
});

describe('useCreateRiskComment (optimistic)', () => {
  const key = ['risk-comments', 'risk-1'];

  beforeEach(() => {
    postMock.mockReset();
  });

  it('optimistically appends the comment to the cached list with the current user as author', async () => {
    postMock.mockReturnValue(new Promise(() => {})); // stay pending → keep optimistic state
    const qc = freshClient();
    qc.setQueryData(key, [existingComment]);

    const { result } = renderHook(() => useCreateRiskComment(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.mutate({ projectId: 'proj-1', riskId: 'risk-1', message: 'hello' });
    });

    await waitFor(() => expect(qc.getQueryData<RiskComment[]>(key)).toHaveLength(2));
    const list = qc.getQueryData<RiskComment[]>(key)!;
    expect(list[0]).toEqual(existingComment);
    expect(list[1].message).toBe('hello');
    expect(list[1].author).toEqual({ id: 'u1', display_name: 'Alice' });
    expect(list[1].id).toMatch(/^optimistic-/);
  });

  it('rolls back to the pre-mutation list when the post fails', async () => {
    postMock.mockRejectedValue(new Error('network'));
    const qc = freshClient();
    qc.setQueryData(key, [existingComment]);

    const { result } = renderHook(() => useCreateRiskComment(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.mutate({ projectId: 'proj-1', riskId: 'risk-1', message: 'doomed' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // The optimistic row is gone; the original list is restored.
    expect(qc.getQueryData<RiskComment[]>(key)).toEqual([existingComment]);
  });

  it('invalidates the comment list on settle so the server row replaces the optimistic one', async () => {
    const serverComment: RiskComment = {
      id: 'c2',
      author: { id: 'u1', display_name: 'Alice' },
      message: 'hello',
      created_at: '2026-06-02T00:00:00Z',
    };
    postMock.mockResolvedValue({ data: serverComment });
    const qc = freshClient();
    qc.setQueryData(key, [existingComment]);
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateRiskComment(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'proj-1',
        riskId: 'risk-1',
        message: 'hello',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['risk-comments', 'risk-1'] });
  });
});
