import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUngroupedProjects } from './useUngroupedProjects';

const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useUngroupedProjects', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('requests the program__isnull filter', async () => {
    getMock.mockResolvedValue({ data: { results: [] } });
    const { result } = renderHook(() => useUngroupedProjects(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/?program__isnull=true');
  });

  it('maps server fields to the UngroupedProject shape', async () => {
    getMock.mockResolvedValue({
      data: {
        results: [
          {
            id: 'pr-1',
            name: 'Neptune Cryo Rig',
            code: 'NEP',
            health: 'AT_RISK',
            percent_complete: 38.4,
            member_count: 4,
          },
        ],
      },
    });
    const { result } = renderHook(() => useUngroupedProjects(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]).toEqual({
      id: 'pr-1',
      name: 'Neptune Cryo Rig',
      code: 'NEP',
      healthState: 'at-risk',
      percentComplete: 38.4,
      memberCount: 4,
    });
  });

  it('maps AUTO and unknown health to "unknown" and tolerates null aggregates', async () => {
    getMock.mockResolvedValue({
      data: { results: [{ id: 'pr-2', name: 'Fresh', health: 'AUTO' }] },
    });
    const { result } = renderHook(() => useUngroupedProjects(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]).toMatchObject({
      healthState: 'unknown',
      code: '',
      percentComplete: null,
      memberCount: null,
    });
  });

  it('handles a bare array response (fixture resilience)', async () => {
    getMock.mockResolvedValue({ data: [{ id: 'pr-3', name: 'Bare', health: 'ON_TRACK' }] });
    const { result } = renderHook(() => useUngroupedProjects(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.healthState).toBe('on-track');
  });
});
