import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useBurnChart } from './useBurnChart';

vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn(),
  },
}));

import { apiClient } from '@/api/client';
// The factory returns plain vi.fn() stubs; cast so we can call .mockResolvedValue etc.
// eslint-disable-next-line @typescript-eslint/unbound-method
const mockGet = apiClient.get as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const RESPONSE = {
  chart_type: 'burndown',
  metric: 'tasks',
  since: '2026-04-01',
  until: '2026-04-14',
  series: [{ date: '2026-04-01', actual: 40, ideal: 40, scope: 40 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useBurnChart', () => {
  it('does not fetch when projectId is null', () => {
    mockGet.mockResolvedValue({ data: RESPONSE });
    const { result } = renderHook(() => useBurnChart(null, 'burndown', 'tasks'), { wrapper });
    expect(result.current.isLoading).toBe(false);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fetches burn data with correct URL when projectId is set', async () => {
    mockGet.mockResolvedValue({ data: RESPONSE });
    const { result } = renderHook(
      () => useBurnChart('proj-1', 'burndown', 'tasks'),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('/projects/proj-1/burn/'),
    );
    expect(result.current.data).toEqual(RESPONSE);
  });

  it('includes since and until params when provided', async () => {
    mockGet.mockResolvedValue({ data: RESPONSE });
    renderHook(
      () => useBurnChart('proj-1', 'burndown', 'tasks', '2026-04-01', '2026-04-14'),
      { wrapper },
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    const url = String(mockGet.mock.calls[0][0]);
    expect(url).toContain('since=2026-04-01');
    expect(url).toContain('until=2026-04-14');
  });

  it('uses the variant and metric in the query URL', async () => {
    mockGet.mockResolvedValue({ data: { ...RESPONSE, chart_type: 'burnup', metric: 'points' } });
    renderHook(
      () => useBurnChart('proj-1', 'burnup', 'points'),
      { wrapper },
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    const url = String(mockGet.mock.calls[0][0]);
    expect(url).toContain('chart_type=burnup');
    expect(url).toContain('metric=points');
  });
});
