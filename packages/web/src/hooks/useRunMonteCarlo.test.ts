import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import axios from 'axios';
import { useRunMonteCarlo } from './useRunMonteCarlo';

const postMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ apiClient: { post: postMock, get: getMock } }));

// The POST queues the run (#2273); the hook then polls the task run.
const QUEUED = { data: { task_run_id: 'run-1', status: 'pending', n_simulations: null } };
const runIs = (status: string, result_summary: Record<string, unknown> | null = null) => ({
  data: { status, result_summary },
});
// Real timers: the hook sleeps MC_POLL_INTERVAL_MS (500 ms) before each poll.
const SETTLE = { timeout: 4000 };

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useRunMonteCarlo', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('POSTs to /projects/{id}/monte-carlo/ on mutate', async () => {
    postMock.mockResolvedValueOnce(QUEUED);
    getMock.mockResolvedValueOnce(runIs('success', { run_id: null }));

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isSuccess).toBe(true), SETTLE);
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/monte-carlo/', {});
  });

  it('forwards n_simulations through to the request body', async () => {
    postMock.mockResolvedValueOnce(QUEUED);
    getMock.mockResolvedValueOnce(runIs('success'));

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ n_simulations: 250 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true), SETTLE);
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/monte-carlo/', { n_simulations: 250 });
  });

  it('invalidates the unified monte-carlo-latest cache key on success', async () => {
    // Pre-#335 there were two parallel hooks with separate cache keys
    // (`mc-latest` for the Overview, `monte-carlo-latest` for the Schedule
    // strip + TopBar). The Overview now consumes the shared
    // `useMonteCarloResult` hook, so a single invalidation propagates to
    // every surface.
    postMock.mockResolvedValueOnce(QUEUED);
    getMock.mockResolvedValueOnce(runIs('success'));
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isSuccess).toBe(true), SETTLE);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['monte-carlo-latest', 'proj-1'] });
    // The legacy `mc-latest` key must NOT be invalidated — it no longer
    // exists, and an unnecessary invalidation would silently mask future
    // regressions where someone re-introduces a parallel hook.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['mc-latest', 'proj-1'] });
  });

  it('rejects without making a request when projectId is undefined', async () => {
    const { result } = renderHook(() => useRunMonteCarlo(undefined), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(postMock).not.toHaveBeenCalled();
    expect(result.current.error?.message).toMatch(/projectId is required/i);
  });

  it('surfaces server errors as the mutation error so callers can render a retry state', async () => {
    postMock.mockRejectedValueOnce(new Error('500 boom'));

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('500 boom');
  });

  it('stays pending until the run finishes, polling the task run', async () => {
    postMock.mockResolvedValueOnce(QUEUED);
    getMock
      .mockResolvedValueOnce(runIs('pending'))
      .mockResolvedValueOnce(runIs('running'))
      .mockResolvedValueOnce(runIs('success', { run_id: 'mc-1' }));
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 5000 });
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/task-runs/run-1/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['monte-carlo-latest', 'proj-1'] });
  });

  it("rejects with the worker's refusal as an axios error carrying its status and body", async () => {
    postMock.mockResolvedValueOnce(QUEUED);
    getMock.mockResolvedValueOnce(
      runIs('failed', {
        detail: 'Cyclic dependency detected.',
        status_code: 400,
      }),
    );

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isError).toBe(true), SETTLE);
    const err = result.current.error;
    expect(axios.isAxiosError(err)).toBe(true);
    if (!axios.isAxiosError(err)) return;
    expect(err.response?.status).toBe(400);
    // The status_code is transport, not body: describeWriteRefusal reads `detail`.
    expect(err.response?.data).toEqual({ detail: 'Cyclic dependency detected.' });
  });

  it('a failed run with no recorded refusal still rejects as a 500', async () => {
    postMock.mockResolvedValueOnce(QUEUED);
    getMock.mockResolvedValueOnce(runIs('failed', null));

    const { result } = renderHook(() => useRunMonteCarlo('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isError).toBe(true), SETTLE);
    const err = result.current.error;
    expect(axios.isAxiosError(err) && err.response?.status).toBe(500);
  });
});
