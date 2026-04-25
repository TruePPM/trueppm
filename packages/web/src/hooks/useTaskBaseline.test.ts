import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useTaskBaseline } from './useTaskBaseline';
import type { BaselineComparison } from './useTaskBaseline';

const getMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: {
      has_baseline: true,
      in_baseline: true,
      baseline_name: 'Sprint 1',
      baseline_taken_at: '2026-03-01T00:00:00Z',
      has_cpm_dates: true,
      planned_start: '2026-03-05',
      planned_finish: '2026-03-20',
      planned_duration: 15,
      planned_actual_start: null,
      planned_actual_finish: null,
      current_start: '2026-03-07',
      current_finish: '2026-03-25',
      current_duration: 16,
      current_actual_start: null,
      current_actual_finish: null,
      start_delta_days: 2,
      finish_delta_days: 5,
      duration_delta: 1,
    } satisfies BaselineComparison,
  }),
);

vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useTaskBaseline', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('fetches from the correct URL', async () => {
    const { result } = renderHook(
      () => useTaskBaseline('proj-1', 'task-1'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/tasks/task-1/baseline/');
  });

  it('returns baseline comparison data', async () => {
    const { result } = renderHook(
      () => useTaskBaseline('proj-1', 'task-1'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const data = result.current.data;
    expect(data?.has_baseline).toBe(true);
    if (data?.has_baseline && data.in_baseline) {
      expect(data.finish_delta_days).toBe(5);
      expect(data.baseline_name).toBe('Sprint 1');
    }
  });

  it('handles no-baseline response', async () => {
    getMock.mockResolvedValueOnce({ data: { has_baseline: false } });
    const { result } = renderHook(
      () => useTaskBaseline('proj-1', 'task-2'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.has_baseline).toBe(false);
  });
});
