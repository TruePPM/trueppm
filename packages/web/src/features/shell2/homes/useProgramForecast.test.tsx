import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useProgramForecast } from './useProgramForecast';

const h = vi.hoisted(() => ({ get: vi.fn(), mcProjectId: vi.fn() }));

vi.mock('@/api/client', () => ({ apiClient: { get: h.get } }));
vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: (id?: string) => {
    h.mcProjectId(id);
    return { result: null };
  },
}));

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

const ROLLUP = {
  as_of: '2026-11-23T00:00:00Z',
  kpis: {
    p80_completion: {
      available: true,
      value: '2027-03-01',
      driver_project_id: 'proj-driver',
    },
  },
};

describe('useProgramForecast', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('does not fetch without a program id', () => {
    const { result } = renderHook(() => useProgramForecast(undefined), { wrapper: wrapper(qc) });
    expect(h.get).not.toHaveBeenCalled();
    expect(result.current.driverId).toBeUndefined();
    expect(h.mcProjectId).toHaveBeenLastCalledWith(undefined);
  });

  it('reads the rollup and hands the driver project to the Monte Carlo read', async () => {
    h.get.mockResolvedValue({ data: ROLLUP });
    const { result } = renderHook(() => useProgramForecast('prog-1'), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.hero.kind).toBe('ready'));
    expect(h.get).toHaveBeenCalledWith('/programs/prog-1/rollup/');
    expect(result.current.driverId).toBe('proj-driver');
    expect(h.mcProjectId).toHaveBeenLastCalledWith('proj-driver');
    expect(qc.getQueryData(['program-rollup', 'prog-1'])).toEqual(ROLLUP);
  });

  it('reports an error hero and no driver when the rollup read fails', async () => {
    h.get.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useProgramForecast('prog-1'), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.hero.kind).toBe('error'));
    expect(result.current.driverId).toBeUndefined();
  });
});
