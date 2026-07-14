import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

import { useProjectsHealthSummary } from './useProjectsHealthSummary';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('useProjectsHealthSummary', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('maps the snake_case endpoint rows to the camelCase hook shape', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        { id: 'p1', name: 'Apollo', health_band: 'critical', at_risk_count: 4, critical_count: 3 },
        { id: 'p2', name: 'Gemini', health_band: 'on_track', at_risk_count: 0, critical_count: 0 },
      ],
    });
    const { result } = renderHook(() => useProjectsHealthSummary(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/projects/health-summary/');
    expect(result.current.data).toEqual([
      { id: 'p1', name: 'Apollo', healthBand: 'critical', atRiskCount: 4, criticalCount: 3 },
      { id: 'p2', name: 'Gemini', healthBand: 'on_track', atRiskCount: 0, criticalCount: 0 },
    ]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces the error after a settled fetch failure', async () => {
    getMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useProjectsHealthSummary(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('boom');
  });
});
