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

  it('POSTs to create a named baseline', async () => {
    postMock.mockResolvedValueOnce({ data: BASELINE });

    const { result } = renderHook(() => useCreateBaseline('proj-1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ name: 'Sprint 1 baseline' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/baselines/', { name: 'Sprint 1 baseline' });
  });

  it('POSTs with empty body when no name supplied', async () => {
    postMock.mockResolvedValueOnce({ data: BASELINE });

    const { result } = renderHook(() => useCreateBaseline('proj-1'), { wrapper: makeWrapper(qc) });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/baselines/', {});
  });

  it('invalidates baselines query on success', async () => {
    postMock.mockResolvedValueOnce({ data: BASELINE });
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

  it('invalidates baselines and tasks queries on success', async () => {
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

  it('invalidates baselines and tasks queries on success', async () => {
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
