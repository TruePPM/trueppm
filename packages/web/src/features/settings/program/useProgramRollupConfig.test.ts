import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useProgramRollupConfig,
  useSaveProgramRollupPolicy,
  useToggleProgramRollupKpi,
  type ProgramRollupConfig,
} from './useProgramRollupConfig';

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock, patch: patchMock } }));

const CONFIG: ProgramRollupConfig = {
  enabled_kpis: ['schedule_health', 'critical_tasks'],
  aggregation_policy: 'worst',
  unavailable_kpis: { cost_variance: 'no_cost_data' },
};
const KEY = ['program-rollup-config', 'pg1'];

let qc: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  getMock.mockReset();
  patchMock.mockReset();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  invalidate = vi.spyOn(qc, 'invalidateQueries');
});

describe('useProgramRollupConfig', () => {
  it('reads the program config and is idle without a program', async () => {
    getMock.mockResolvedValue({ data: CONFIG });
    const { result } = renderHook(() => useProgramRollupConfig('pg1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(CONFIG));
    expect(getMock).toHaveBeenCalledWith('/programs/pg1/rollup-config/');
    const { result: idle } = renderHook(() => useProgramRollupConfig(undefined), { wrapper });
    expect(idle.current.fetchStatus).toBe('idle');
  });
});

describe('useToggleProgramRollupKpi', () => {
  it('applies the toggle optimistically, then refetches on settle', async () => {
    qc.setQueryData(KEY, CONFIG);
    getMock.mockResolvedValue({ data: { ...CONFIG, enabled_kpis: ['schedule_health'] } });
    let resolvePatch: (v: unknown) => void = () => {};
    patchMock.mockReturnValue(new Promise((r) => (resolvePatch = r)));
    const { result } = renderHook(() => useToggleProgramRollupKpi('pg1'), { wrapper });

    act(() => result.current.mutate(['schedule_health']));
    await waitFor(() =>
      expect(qc.getQueryData<ProgramRollupConfig>(KEY)?.enabled_kpis).toEqual(['schedule_health']),
    );
    // Other fields survive the optimistic write.
    expect(qc.getQueryData<ProgramRollupConfig>(KEY)?.aggregation_policy).toBe('worst');
    expect(patchMock).toHaveBeenCalledWith('/programs/pg1/rollup-config/', {
      enabled_kpis: ['schedule_health'],
    });

    await act(async () => {
      resolvePatch({ data: { ...CONFIG, enabled_kpis: ['schedule_health'] } });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Settle invalidates the config so any mounted reader reconciles with the server.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it('rolls the cache back when the server refuses', async () => {
    qc.setQueryData(KEY, CONFIG);
    getMock.mockResolvedValue({ data: CONFIG });
    patchMock.mockRejectedValue(new Error('403'));
    const { result } = renderHook(() => useToggleProgramRollupKpi('pg1'), { wrapper });
    act(() => result.current.mutate([]));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData<ProgramRollupConfig>(KEY)?.enabled_kpis).toEqual(CONFIG.enabled_kpis);
  });

  it('does not seed a cache entry when nothing was loaded yet', async () => {
    patchMock.mockResolvedValue({ data: CONFIG });
    getMock.mockResolvedValue({ data: CONFIG });
    const { result } = renderHook(() => useToggleProgramRollupKpi('pg1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(['risk_score']);
    });
    // Only the settle-time refetch can populate it, never the optimistic step.
    expect(patchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useSaveProgramRollupPolicy', () => {
  it('is not optimistic: the cache changes only on success, to the server body', async () => {
    qc.setQueryData(KEY, CONFIG);
    let resolvePatch: (v: unknown) => void = () => {};
    patchMock.mockReturnValue(new Promise((r) => (resolvePatch = r)));
    const { result } = renderHook(() => useSaveProgramRollupPolicy('pg1'), { wrapper });
    act(() => result.current.mutate('average'));
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/programs/pg1/rollup-config/', {
        aggregation_policy: 'average',
      }),
    );
    expect(qc.getQueryData<ProgramRollupConfig>(KEY)?.aggregation_policy).toBe('worst');
    await act(async () => {
      resolvePatch({ data: { ...CONFIG, aggregation_policy: 'average' } });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(qc.getQueryData<ProgramRollupConfig>(KEY)?.aggregation_policy).toBe('average'),
    );
  });
});
