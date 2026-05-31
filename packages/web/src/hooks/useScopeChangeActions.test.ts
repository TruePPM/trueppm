/**
 * Tests for useScopeChangeActions (ADR-0102 §5) — verifies the four endpoint
 * shapes (single + bulk accept/reject) and the bulk omit-ids = act-on-all body.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useScopeChangeActions } from './useScopeChangeActions';

const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn().mockResolvedValue({ data: { pending_count: 0 } }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useScopeChangeActions', () => {
  beforeEach(() => postMock.mockClear());

  it('single accept POSTs the scope-change accept endpoint', async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeChangeActions('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.acceptOne.mutate('sc-9');
    await waitFor(() => expect(result.current.acceptOne.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/scope-changes/sc-9/accept/');
  });

  it('single reject POSTs the scope-change reject endpoint', async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeChangeActions('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.rejectOne.mutate('sc-9');
    await waitFor(() => expect(result.current.rejectOne.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/scope-changes/sc-9/reject/');
  });

  it('bulk accept with no ids sends an empty body = act on ALL pending', async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeChangeActions('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.acceptBulk.mutate(undefined);
    await waitFor(() => expect(result.current.acceptBulk.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/s1/scope-changes/accept/', {});
  });

  it('bulk reject with explicit ids forwards the ids list', async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeChangeActions('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.rejectBulk.mutate(['a', 'b']);
    await waitFor(() => expect(result.current.rejectBulk.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/s1/scope-changes/reject/', {
      ids: ['a', 'b'],
    });
  });
});
