import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { AgentDetail, AgentScope } from '@/api/types';
import {
  agentKeys,
  useAgent,
  useAgentAuditVerify,
  useAgentControl,
  useAgents,
  useEditAgentScope,
} from './useAgents';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock, patch: patchMock } }));

let qc: QueryClient;
let invalidate: MockInstance<QueryClient['invalidateQueries']>;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  [getMock, postMock, patchMock].forEach((m) => m.mockReset());
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
});

describe('agentKeys', () => {
  it('keys the list by program, with null for the unfiltered list', () => {
    expect(agentKeys.list()).toEqual(['agents', 'list', null]);
    expect(agentKeys.list('p1')).toEqual(['agents', 'list', 'p1']);
    expect(agentKeys.detail('a1')).toEqual(['agents', 'detail', 'a1']);
  });
});

describe('useAgents', () => {
  it('fetches the unfiltered list with no params', async () => {
    getMock.mockResolvedValue({ data: { results: [] } });
    const { result } = renderHook(() => useAgents(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/agents/', { params: undefined });
  });

  it('passes the program filter through', async () => {
    getMock.mockResolvedValue({ data: { results: [] } });
    const { result } = renderHook(() => useAgents('p1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/agents/', { params: { program: 'p1' } });
  });
});

describe('useAgent', () => {
  it('stays disabled until an agent is selected', () => {
    const { result } = renderHook(() => useAgent(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('fetches the selected agent', async () => {
    getMock.mockResolvedValue({ data: { id: 'a1' } });
    const { result } = renderHook(() => useAgent('a1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/agents/a1/');
  });
});

describe('useAgentAuditVerify', () => {
  it('reads the verified-log line', async () => {
    getMock.mockResolvedValue({ data: { verified: true } });
    const { result } = renderHook(() => useAgentAuditVerify(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/agents/audit-verify/');
  });
});

describe('useAgentControl', () => {
  it('posts the action with the reason, caches the detail and invalidates the family', async () => {
    const detail = { id: 'a1' } as AgentDetail;
    postMock.mockResolvedValue({ data: detail });
    const { result } = renderHook(() => useAgentControl('a1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ action: 'pause', reason: 'noisy' });
    });
    expect(postMock).toHaveBeenCalledWith('/agents/a1/pause/', { reason: 'noisy' });
    expect(qc.getQueryData(agentKeys.detail('a1'))).toEqual(detail);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentKeys.all });
  });

  it('sends an empty reason when none is given', async () => {
    postMock.mockResolvedValue({ data: { id: 'a1' } });
    const { result } = renderHook(() => useAgentControl('a1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ action: 'revoke' });
    });
    expect(postMock).toHaveBeenCalledWith('/agents/a1/revoke/', { reason: '' });
  });

  it('leaves the cache untouched when the server refuses', async () => {
    postMock.mockRejectedValue(new Error('refused'));
    const { result } = renderHook(() => useAgentControl('a1'), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ action: 'resume' })).rejects.toThrow('refused');
    });
    expect(qc.getQueryData(agentKeys.detail('a1'))).toBeUndefined();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('useEditAgentScope', () => {
  it('patches the scope, caches the detail and invalidates the family', async () => {
    const detail = { id: 'a1' } as AgentDetail;
    patchMock.mockResolvedValue({ data: detail });
    const scope = { schedule: 'read' } as unknown as AgentScope;
    const { result } = renderHook(() => useEditAgentScope('a1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ scope });
    });
    expect(patchMock).toHaveBeenCalledWith('/agents/a1/scope/', { scope, reason: '' });
    expect(qc.getQueryData(agentKeys.detail('a1'))).toEqual(detail);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentKeys.all });
  });
});
