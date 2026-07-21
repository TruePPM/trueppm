import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useBaselines,
  useBaselineDetail,
  useCreateBaseline,
  useActivateBaseline,
  useDeleteBaseline,
} from './useBaselines';
import type { ApiBaseline, ApiBaselineDetail } from './useBaselines';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock('@/api', () => ({ apiClient: { get: getMock, post: postMock, delete: deleteMock } }));

const BASELINE: ApiBaseline = {
  id: 'bl-1',
  project: 'proj-1',
  name: 'Baseline 1',
  created_by: 'user-1',
  created_at: '2026-05-01T00:00:00Z',
  is_active: false,
  has_cpm_dates: true,
  task_count: 5,
};

const BASELINE_DETAIL: ApiBaselineDetail = {
  ...BASELINE,
  tasks: [
    { task_id: 't-1', task_name: 'Task A', start: '2026-05-01', finish: '2026-05-05', duration: 4 },
  ],
};

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

// ---------------------------------------------------------------------------
// useBaselines
// ---------------------------------------------------------------------------

describe('useBaselines', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('fetches the baseline list for a project', async () => {
    getMock.mockResolvedValueOnce({ data: { results: [BASELINE] } });

    const { result } = renderHook(() => useBaselines('proj-1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/baselines/');
    expect(result.current.data).toEqual([BASELINE]);
  });

  it('is disabled when projectId is null', () => {
    const { result } = renderHook(() => useBaselines(null), { wrapper: makeWrapper(qc) });
    expect(result.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// useBaselineDetail
// ---------------------------------------------------------------------------

describe('useBaselineDetail', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('fetches a single baseline with task snapshot', async () => {
    getMock.mockResolvedValueOnce({ data: BASELINE_DETAIL });

    const { result } = renderHook(
      () => useBaselineDetail('proj-1', 'bl-1'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/baselines/bl-1/');
    expect(result.current.data?.tasks).toHaveLength(1);
  });

  it('is disabled when baselineId is null', () => {
    const { result } = renderHook(
      () => useBaselineDetail('proj-1', null),
      { wrapper: makeWrapper(qc) },
    );
    expect(result.current.fetchStatus).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// useCreateBaseline
// ---------------------------------------------------------------------------

describe('useCreateBaseline', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  // Helper: the create hook reads the authoritative list between create and
  // (optional) activate. `existing` is the list the GET resolves to.
  function mockFirstBaselineCapture(existing: ApiBaseline[] = []) {
    // 1. POST create → new (inactive) baseline
    postMock.mockResolvedValueOnce({ data: BASELINE });
    // 2. GET list → whatever baselines already exist (excluding/including the new one)
    getMock.mockResolvedValueOnce({ data: { results: [...existing, BASELINE] } });
    // 3. POST activate → same baseline, now active
    postMock.mockResolvedValueOnce({ data: { ...BASELINE, is_active: true } });
  }

  it('POSTs to create a named baseline', async () => {
    mockFirstBaselineCapture();

    const { result } = renderHook(() => useCreateBaseline('proj-1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ name: 'Sprint 1 baseline' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenNthCalledWith(1, '/projects/proj-1/baselines/', {
      name: 'Sprint 1 baseline',
    });
  });

  it('POSTs with empty body when no name supplied', async () => {
    mockFirstBaselineCapture();

    const { result } = renderHook(() => useCreateBaseline('proj-1'), { wrapper: makeWrapper(qc) });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenNthCalledWith(1, '/projects/proj-1/baselines/', {});
  });

  it('auto-activates the FIRST baseline (no active one yet) and invalidates tasks', async () => {
    // No prior active baseline in the project → capture should chain activate.
    mockFirstBaselineCapture();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateBaseline('proj-1'), { wrapper: makeWrapper(qc) });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Second POST is the activate call for the just-created baseline.
    expect(postMock).toHaveBeenNthCalledWith(2, '/projects/proj-1/baselines/bl-1/activate/');
    // The resolved value is the now-active baseline.
    expect(result.current.data?.is_active).toBe(true);
    // Board-card readiness is derived from the active baseline overlay, so
    // tasks must be refreshed too.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['baselines', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('does NOT reactivate when an active baseline already exists', async () => {
    // POST create → new (inactive) baseline
    postMock.mockResolvedValueOnce({ data: { ...BASELINE, id: 'bl-2', is_active: false } });
    // GET list → an already-active baseline is present besides the new one
    getMock.mockResolvedValueOnce({
      data: {
        results: [
          { ...BASELINE, id: 'bl-1', is_active: true },
          { ...BASELINE, id: 'bl-2', is_active: false },
        ],
      },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateBaseline('proj-1'), { wrapper: makeWrapper(qc) });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Only the create POST fires — no activate call.
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).not.toHaveBeenCalledWith('/projects/proj-1/baselines/bl-2/activate/');
    expect(result.current.data?.is_active).toBe(false);
    // Baselines list still refreshes, but tasks readiness is unchanged.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['baselines', 'proj-1'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('invalidates baselines query on success', async () => {
    mockFirstBaselineCapture();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateBaseline('proj-1'), { wrapper: makeWrapper(qc) });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['baselines', 'proj-1'] });
  });
});

// ---------------------------------------------------------------------------
// useActivateBaseline
// ---------------------------------------------------------------------------

describe('useActivateBaseline', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('POSTs to the activate action endpoint', async () => {
    postMock.mockResolvedValueOnce({ data: { ...BASELINE, is_active: true } });

    const { result } = renderHook(
      () => useActivateBaseline('proj-1'),
      { wrapper: makeWrapper(qc) },
    );

    result.current.mutate('bl-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/baselines/bl-1/activate/');
  });

  it('useActivateBaseline — invalidates baselines and tasks queries on success', async () => {
    postMock.mockResolvedValueOnce({ data: { ...BASELINE, is_active: true } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(
      () => useActivateBaseline('proj-1'),
      { wrapper: makeWrapper(qc) },
    );

    result.current.mutate('bl-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['baselines', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });
});

// ---------------------------------------------------------------------------
// useDeleteBaseline
// ---------------------------------------------------------------------------

describe('useDeleteBaseline', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('DELETEs the baseline endpoint', async () => {
    deleteMock.mockResolvedValueOnce({});

    const { result } = renderHook(
      () => useDeleteBaseline('proj-1'),
      { wrapper: makeWrapper(qc) },
    );

    result.current.mutate('bl-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(deleteMock).toHaveBeenCalledWith('/projects/proj-1/baselines/bl-1/');
  });

  it('useDeleteBaseline — invalidates baselines and tasks queries on success', async () => {
    deleteMock.mockResolvedValueOnce({});
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(
      () => useDeleteBaseline('proj-1'),
      { wrapper: makeWrapper(qc) },
    );

    result.current.mutate('bl-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['baselines', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });
});
