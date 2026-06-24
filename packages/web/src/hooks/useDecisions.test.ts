/**
 * Tests for the Decisions-view hooks (ADR-0167, #784 backfill).
 *
 * The behavior worth pinning is not the raw fetch but the policy logic layered on
 * top: a 403 from a denied oversight reader must surface as `isLocked` (a
 * team-owned locked state) rather than a thrown error; pages accumulate across
 * "Load more"; the sprint scope is an optional query param; and flipping the
 * visibility policy must invalidate the Decisions list so a newly-allowed reader
 * re-fetches.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useDecisions,
  useSetDecisionsPolicy,
  decisionsPolicyKey,
} from './useDecisions';
import type { DecisionNote, DecisionsPolicy } from '@/types';

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock, patch: patchMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function freshClient() {
  // `useDecisions` overrides `retry` per-query (it retries real failures but not a
  // 403), so the client-level `retry: false` doesn't suppress those retries —
  // `retryDelay: 0` keeps the non-403 retry path instant instead of backing off.
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

function makeDecision(id: string): DecisionNote {
  return {
    id,
    body: `decision ${id}`,
    decision: true,
    pinned: false,
    author: null,
    edited_at: null,
    created_at: '2026-06-01T00:00:00Z',
    task: { id: 't1', name: 'Task 1' },
    sprint: null,
  };
}

function page(results: DecisionNote[], next: string | null) {
  return { data: { count: results.length, next, previous: null, results } };
}

describe('useDecisions', () => {
  beforeEach(() => {
    getMock.mockReset();
    patchMock.mockReset();
  });

  it('surfaces a 403 as isLocked, not an error', async () => {
    getMock.mockRejectedValue(httpError(403));
    const { result } = renderHook(() => useDecisions('proj-1', null), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => expect(result.current.isLocked).toBe(true));
    // The locked state is handled separately, so `error` stays null.
    expect(result.current.error).toBeNull();
    expect(result.current.decisions).toEqual([]);
  });

  it('surfaces a non-403 failure as a real error (not locked)', async () => {
    getMock.mockRejectedValue(httpError(500));
    const { result } = renderHook(() => useDecisions('proj-1', null), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.isLocked).toBe(false);
  });

  it('does not fetch when projectId is empty', () => {
    const { result } = renderHook(() => useDecisions('', null), {
      wrapper: makeWrapper(freshClient()),
    });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.decisions).toEqual([]);
  });

  it('omits the sprint param in project scope, includes it in sprint scope', async () => {
    getMock.mockResolvedValue(page([makeDecision('a')], null));

    const projectScope = renderHook(() => useDecisions('proj-1', null), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => expect(projectScope.result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenLastCalledWith('/projects/proj-1/decisions/', {
      params: { page: 1 },
    });

    getMock.mockClear();
    getMock.mockResolvedValue(page([makeDecision('a')], null));
    const sprintScope = renderHook(() => useDecisions('proj-1', 'sprint-9'), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => expect(sprintScope.result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenLastCalledWith('/projects/proj-1/decisions/', {
      params: { page: 1, sprint: 'sprint-9' },
    });
  });

  it('accumulates pages across fetchNextPage and stops when next is null', async () => {
    getMock.mockImplementation((_url: string, config?: { params?: { page?: number } }) => {
      const p = config?.params?.page;
      return p === 1
        ? Promise.resolve(page([makeDecision('a')], 'http://api/decisions/?page=2'))
        : Promise.resolve(page([makeDecision('b')], null));
    });

    const { result } = renderHook(() => useDecisions('proj-1', null), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => expect(result.current.decisions).toHaveLength(1));
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.decisions).toHaveLength(2));
    expect(result.current.decisions.map((d) => d.id)).toEqual(['a', 'b']);
    // Second page requested page 2 (allPages.length + 1).
    expect(getMock).toHaveBeenLastCalledWith('/projects/proj-1/decisions/', {
      params: { page: 2 },
    });
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('useSetDecisionsPolicy', () => {
  beforeEach(() => {
    getMock.mockReset();
    patchMock.mockReset();
  });

  it('writes the new policy to cache and invalidates the Decisions list', async () => {
    const updated: DecisionsPolicy = { oversight_visible: true, can_edit: true };
    patchMock.mockResolvedValue({ data: updated });
    const qc = freshClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useSetDecisionsPolicy(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ projectId: 'proj-1', oversightVisible: true });
    });

    expect(patchMock).toHaveBeenCalledWith('/projects/proj-1/decisions-policy/', {
      oversight_visible: true,
    });
    // Policy read is primed from the response so the toggle reflects immediately.
    expect(qc.getQueryData(decisionsPolicyKey('proj-1'))).toEqual(updated);
    // A newly-allowed reader's list must re-fetch.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['decisions', 'proj-1'] });
  });
});
