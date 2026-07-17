import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { AgentAction } from '@/api/types';
import { useProgramAgentActions } from './useProgramAgentActions';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function action(seq: number): AgentAction {
  return {
    id: `a${seq}`,
    schema_version: 1,
    sequence: seq,
    actor_kind: 'mcp_token',
    actor_token_prefix: 'tok',
    principal: 'u1',
    action: 'get_schedule',
    method: 'GET',
    object_type: '',
    object_id: '',
    project: 'p1',
    capability_used: 'mcp:read',
    verdict: 'allowed',
    refusal_reason: '',
    refusal_detail: null,
    engine_version: 'e',
    payload_hash: 'ph',
    record_hash: 'rh',
    summary: '',
    occurred_at: new Date().toISOString(),
  };
}

function page(results: AgentAction[], next: string | null) {
  return { data: { count: results.length, next, previous: null, results } };
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => vi.clearAllMocks());

describe('useProgramAgentActions', () => {
  it('is disabled and returns no actions when programId is undefined', () => {
    const { result } = renderHook(() => useProgramAgentActions(undefined), {
      wrapper: makeWrapper(),
    });
    expect(result.current.actions).toEqual([]);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('requests the program filter and flattens page results', async () => {
    getMock.mockResolvedValueOnce(page([action(1), action(2)], null));
    const { result } = renderHook(() => useProgramAgentActions('prog-1'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/agent-actions/', {
      params: { program: 'prog-1', page: 1 },
    });
    expect(result.current.actions.map((a) => a.sequence)).toEqual([1, 2]);
    expect(result.current.hasNextPage).toBe(false);
  });

  it('adds since + verdict params and fetches the next page when present', async () => {
    getMock.mockResolvedValueOnce(page([action(1)], 'http://x/?page=2'));
    getMock.mockResolvedValueOnce(page([action(2)], null));
    const { result } = renderHook(
      () => useProgramAgentActions('prog-1', { since: '2026-07-01T00:00:00Z', verdict: 'refused' }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/agent-actions/', {
      params: { program: 'prog-1', page: 1, since: '2026-07-01T00:00:00Z', verdict: 'refused' },
    });
    expect(result.current.hasNextPage).toBe(true);

    result.current.fetchNextPage();
    await waitFor(() => expect(result.current.actions).toHaveLength(2));
    expect(getMock).toHaveBeenLastCalledWith('/agent-actions/', {
      params: { program: 'prog-1', page: 2, since: '2026-07-01T00:00:00Z', verdict: 'refused' },
    });
  });

  it('surfaces the error state when the request fails', async () => {
    getMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useProgramAgentActions('prog-1'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.actions).toEqual([]);
  });
});
