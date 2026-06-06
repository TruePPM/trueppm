import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useMilestoneCandidates,
  usePromoteSprintToMilestone,
  useReforecastPreview,
} from './usePromoteMilestone';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

// ---------------------------------------------------------------------------
// usePromoteSprintToMilestone — body shaping (§E1.2 create overrides)
// ---------------------------------------------------------------------------

describe('usePromoteSprintToMilestone', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('create+bind sends the edited name + target_date', async () => {
    postMock.mockResolvedValueOnce({ data: {} });
    const { result } = renderHook(() => usePromoteSprintToMilestone('proj-1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({ sprintId: 'sp-1', name: 'Beta Gate', targetDate: '2026-07-30' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/sp-1/promote-to-milestone/', {
      name: 'Beta Gate',
      target_date: '2026-07-30',
    });
  });

  it('create+bind omits a blank name so the backend default applies', async () => {
    postMock.mockResolvedValueOnce({ data: {} });
    const { result } = renderHook(() => usePromoteSprintToMilestone('proj-1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({ sprintId: 'sp-1', name: '   ', targetDate: '2026-07-30' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/sp-1/promote-to-milestone/', {
      target_date: '2026-07-30',
    });
  });

  it('bind-existing sends only milestone_id and ignores create overrides', async () => {
    postMock.mockResolvedValueOnce({ data: {} });
    const { result } = renderHook(() => usePromoteSprintToMilestone('proj-1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({
      sprintId: 'sp-1',
      milestoneId: 'm-9',
      name: 'ignored',
      targetDate: '2026-07-30',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/sp-1/promote-to-milestone/', {
      milestone_id: 'm-9',
    });
  });
});

// ---------------------------------------------------------------------------
// useMilestoneCandidates — live slim endpoint + snake→camel mapping
// ---------------------------------------------------------------------------

describe('useMilestoneCandidates', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('maps the slim rows and excludes the currently-bound milestone', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        { id: 'm-1', name: 'FAT', wbs_path: '1.3.1', early_finish: '2026-07-18', is_bound: false },
        { id: 'm-2', name: 'P3', wbs_path: '1.4.0', early_finish: null, is_bound: true },
      ],
    });
    const { result } = renderHook(() => useMilestoneCandidates('proj-1', 'm-2'), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/milestones/');
    // m-2 (the currently-bound one) is excluded; m-1 maps wbs_path→wbs etc.
    expect(result.current.candidates).toEqual([
      { id: 'm-1', name: 'FAT', wbs: '1.3.1', finish: '2026-07-18', isBound: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// useReforecastPreview — live read + snake→camel mapping
// ---------------------------------------------------------------------------

describe('useReforecastPreview', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  const API = {
    basis: 'velocity_band',
    cpm_finish: '2026-07-18',
    p50: '2026-07-18',
    p80: '2026-07-22',
    p95: '2026-07-26',
    velocity_low: 21,
    velocity_high: 27,
    unmodeled_dependency: true,
    unmodeled_predecessor_ids: ['t-9'],
  };

  it('create mode omits milestone_id and maps the band to camelCase', async () => {
    getMock.mockResolvedValueOnce({ data: API });
    const { result } = renderHook(() => useReforecastPreview('sp-1', null, true), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/reforecast-preview/', { params: {} });
    expect(result.current.preview).toEqual({
      basis: 'velocity_band',
      cpmFinish: '2026-07-18',
      p50: '2026-07-18',
      p80: '2026-07-22',
      p95: '2026-07-26',
      teamPaceLow: 21,
      teamPaceHigh: 27,
      unmodeledDependency: true,
    });
  });

  it('bind mode passes the selected milestone_id as a query param', async () => {
    getMock.mockResolvedValueOnce({ data: API });
    const { result } = renderHook(() => useReforecastPreview('sp-1', 'm-1', true), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/reforecast-preview/', {
      params: { milestone_id: 'm-1' },
    });
  });

  it('returns null when there is no CPM anchor', async () => {
    getMock.mockResolvedValueOnce({ data: { ...API, cpm_finish: null } });
    const { result } = renderHook(() => useReforecastPreview('sp-1', null, true), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.preview).toBeNull();
  });

  it('is disabled until enabled', () => {
    const { result } = renderHook(() => useReforecastPreview('sp-1', null, false), {
      wrapper: makeWrapper(qc),
    });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
  });
});
