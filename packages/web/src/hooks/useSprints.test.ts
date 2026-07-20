import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  __testing,
  isFullRetro,
  useSprints,
  useActiveSprint,
  useSprintsByState,
  useSprintMutations,
  useSprintBurndown,
  useSprintCapacity,
  useIncomingCarryover,
  useSprintScopeChanges,
  useSprintDurationChanges,
  useProjectVelocity,
  useProjectForecast,
  useSprintForecast,
  useFlowMetrics,
  useSprintOutcome,
  useToggleDemo,
  useReorderDemoList,
  useSetPresenter,
  useSetReviewNote,
  useFlagForBacklog,
  useSprintDailyDelta,
  useSprintHealth,
  useSprintRetro,
  useSaveSprintRetro,
  useUpdateRetroVisibility,
  useSprintRetroPrior,
  usePromoteRetroActionItem,
  usePullCarryoverToSprint,
  useProjectRetroCarryover,
  useAcceptSuggestion,
  useDeclineSuggestion,
  useRevokeSuggestion,
} from './useSprints';
import type { SprintRetroResponse } from './useSprints';
import type { ApiSprint } from '@/types';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function newQc() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function notFound() {
  return { response: { status: 404 } };
}

function sprint(overrides: Partial<ApiSprint>): ApiSprint {
  return {
    id: overrides.id ?? 'sp-id',
    server_version: 1,
    short_id: 'A1B2',
    short_id_display: 'SP-A1B2',
    name: 'Sprint',
    goal: '',
    notes: '',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
    state: 'PLANNED',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: null,
    wip_limit: null,
    committed_points: null,
    committed_task_count: null,
    completed_points: null,
    completed_task_count: null,
    completion_ratio_points: null,
    completion_ratio_tasks: null,
    activated_at: null,
    closed_at: null,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('useSprints — bucketByState', () => {
  it('separates closed, active, and planned sprints', () => {
    const closed1 = sprint({ id: '1', state: 'COMPLETED', start_date: '2026-01-01' });
    const closed2 = sprint({ id: '2', state: 'CANCELLED', start_date: '2026-02-01' });
    const active = sprint({ id: '3', state: 'ACTIVE', start_date: '2026-03-01' });
    const planned1 = sprint({ id: '4', state: 'PLANNED', start_date: '2026-04-01' });
    const planned2 = sprint({ id: '5', state: 'PLANNED', start_date: '2026-05-01' });

    const result = __testing.bucketByState([planned2, active, closed2, planned1, closed1]);

    expect(result.closed.map((s) => s.id)).toEqual(['1', '2']);
    expect(result.active?.id).toBe('3');
    expect(result.planned.map((s) => s.id)).toEqual(['4', '5']);
  });

  it('returns null active when no sprint is ACTIVE', () => {
    const result = __testing.bucketByState([
      sprint({ id: '1', state: 'COMPLETED' }),
      sprint({ id: '2', state: 'PLANNED' }),
    ]);
    expect(result.active).toBeNull();
  });

  it('groups CANCELLED sprints with closed (the strip greys both)', () => {
    const result = __testing.bucketByState([
      sprint({ id: '1', state: 'CANCELLED', start_date: '2026-01-01' }),
      sprint({ id: '2', state: 'COMPLETED', start_date: '2026-02-01' }),
    ]);
    expect(result.closed).toHaveLength(2);
    expect(result.planned).toHaveLength(0);
  });

  it('sorts each bucket by start_date ascending', () => {
    const result = __testing.bucketByState([
      sprint({ id: 'late', state: 'COMPLETED', start_date: '2026-03-01' }),
      sprint({ id: 'early', state: 'COMPLETED', start_date: '2026-01-01' }),
      sprint({ id: 'mid', state: 'COMPLETED', start_date: '2026-02-01' }),
    ]);
    expect(result.closed.map((s) => s.id)).toEqual(['early', 'mid', 'late']);
  });

  it('handles an empty input', () => {
    const result = __testing.bucketByState([]);
    expect(result).toEqual({ closed: [], active: null, planned: [] });
  });
});

// ---------------------------------------------------------------------------
// useSprints — the list query the derived hooks read from
// ---------------------------------------------------------------------------

describe('useSprints', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newQc();
    vi.clearAllMocks();
  });

  it('fetches the project sprint list and unwraps paginated results', async () => {
    const sprints = [sprint({ id: 'a' }), sprint({ id: 'b' })];
    getMock.mockResolvedValueOnce({ data: { count: 2, next: null, previous: null, results: sprints } });

    const { result } = renderHook(() => useSprints('proj-1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/sprints/');
    expect(result.current.sprints.map((s) => s.id)).toEqual(['a', 'b']);
    expect(result.current.error).toBeNull();
  });

  it('is disabled and returns an empty list when projectId is null', () => {
    const { result } = renderHook(() => useSprints(null), { wrapper: makeWrapper(qc) });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.sprints).toEqual([]);
  });

  it('surfaces the query error on a failed fetch', async () => {
    getMock.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useSprints('proj-1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.sprints).toEqual([]);
  });

  it('refetch re-runs the underlying query', async () => {
    getMock.mockResolvedValue({ data: { count: 0, next: null, previous: null, results: [] } });

    const { result } = renderHook(() => useSprints('proj-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refetch?.();
    });
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
  });
});

// ---------------------------------------------------------------------------
// useActiveSprint — derived, no extra request
// ---------------------------------------------------------------------------

describe('useActiveSprint', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newQc();
    vi.clearAllMocks();
  });

  it('returns the single ACTIVE sprint from the cached list', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        count: 2,
        next: null,
        previous: null,
        results: [sprint({ id: 'p', state: 'PLANNED' }), sprint({ id: 'live', state: 'ACTIVE' })],
      },
    });

    const { result } = renderHook(() => useActiveSprint('proj-1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.sprint).not.toBeNull());
    expect(result.current.sprint?.id).toBe('live');
    // exactly one GET — the active sprint is derived, not separately fetched
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when no sprint is ACTIVE', async () => {
    getMock.mockResolvedValueOnce({
      data: { count: 1, next: null, previous: null, results: [sprint({ id: 'p', state: 'PLANNED' })] },
    });

    const { result } = renderHook(() => useActiveSprint('proj-1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.sprint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useSprintsByState — bucketing wired to the live query
// ---------------------------------------------------------------------------

describe('useSprintsByState', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newQc();
    vi.clearAllMocks();
  });

  it('buckets the fetched sprints and passes through loading/error', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        count: 3,
        next: null,
        previous: null,
        results: [
          sprint({ id: 'done', state: 'COMPLETED', start_date: '2026-01-01' }),
          sprint({ id: 'live', state: 'ACTIVE', start_date: '2026-02-01' }),
          sprint({ id: 'next', state: 'PLANNED', start_date: '2026-03-01' }),
        ],
      },
    });

    const { result } = renderHook(() => useSprintsByState('proj-1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.closed.map((s) => s.id)).toEqual(['done']);
    expect(result.current.active?.id).toBe('live');
    expect(result.current.planned.map((s) => s.id)).toEqual(['next']);
    expect(result.current.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useSprintMutations
// ---------------------------------------------------------------------------

describe('useSprintMutations', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newQc();
    vi.clearAllMocks();
  });

  it('createSprint POSTs the payload and invalidates the sprint list', async () => {
    postMock.mockResolvedValueOnce({ data: sprint({ id: 'new' }) });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useSprintMutations('proj-1'), { wrapper: makeWrapper(qc) });
    result.current.createSprint.mutate({
      name: 'Sprint 3',
      start_date: '2026-05-01',
      finish_date: '2026-05-14',
    });

    await waitFor(() => expect(result.current.createSprint.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/sprints/', {
      name: 'Sprint 3',
      start_date: '2026-05-01',
      finish_date: '2026-05-14',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sprints', 'proj-1'] });
  });

  it('closeSprint POSTs to the outbox close endpoint with carry-over policy', async () => {
    postMock.mockResolvedValueOnce({ data: { queued: true, request_id: 'req-1' } });

    const { result } = renderHook(() => useSprintMutations('proj-1'), { wrapper: makeWrapper(qc) });
    result.current.closeSprint.mutate({
      sprintId: 'sp-9',
      payload: { carry_over_to: 'backlog', pending_disposition: 'carry' },
    });

    await waitFor(() => expect(result.current.closeSprint.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/sp-9/close/', {
      carry_over_to: 'backlog',
      pending_disposition: 'carry',
    });
    expect(result.current.closeSprint.data?.request_id).toBe('req-1');
  });

  it('activateSprint POSTs an empty body to the activate action', async () => {
    postMock.mockResolvedValueOnce({ data: { ...sprint({ id: 'sp-9', state: 'ACTIVE' }), warnings: [] } });

    const { result } = renderHook(() => useSprintMutations('proj-1'), { wrapper: makeWrapper(qc) });
    result.current.activateSprint.mutate('sp-9');

    await waitFor(() => expect(result.current.activateSprint.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/sp-9/activate/', {});
  });

  it('updateSprint PATCHes and invalidates list, velocity, and forecast caches', async () => {
    patchMock.mockResolvedValueOnce({ data: sprint({ id: 'sp-9', capacity_points: 20 }) });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useSprintMutations('proj-1'), { wrapper: makeWrapper(qc) });
    result.current.updateSprint.mutate({ sprintId: 'sp-9', payload: { capacity_points: 20 } });

    await waitFor(() => expect(result.current.updateSprint.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/sprints/sp-9/', { capacity_points: 20 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sprints', 'proj-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project', 'proj-1', 'velocity'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project', 'proj-1', 'forecast'] });
  });
});

// ---------------------------------------------------------------------------
// Simple GET reads: URL, unwrap, and null-id disable gate
// ---------------------------------------------------------------------------

describe('sprint GET reads', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newQc();
    vi.clearAllMocks();
  });

  it('useSprintBurndown fetches the burn series, disabled when null', async () => {
    getMock.mockResolvedValueOnce({ data: { sprint: sprint({}), snapshots: [] } });
    const { result } = renderHook(() => useSprintBurndown('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/burndown/');

    vi.clearAllMocks();
    const { result: off } = renderHook(() => useSprintBurndown(null), { wrapper: makeWrapper(qc) });
    expect(off.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('useSprintCapacity fetches per-person capacity', async () => {
    getMock.mockResolvedValueOnce({ data: { members: [], totals: {}, working_days: 10, hours_per_day: 6 } });
    const { result } = renderHook(() => useSprintCapacity('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/capacity/');
  });

  it('useIncomingCarryover fetches the carryover preview', async () => {
    getMock.mockResolvedValueOnce({ data: { prior_sprint: null, tasks: [] } });
    const { result } = renderHook(() => useIncomingCarryover('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/incoming_carryover/');
  });

  it('useSprintScopeChanges fetches the scope-change audit', async () => {
    getMock.mockResolvedValueOnce({ data: { summary: {}, events: [] } });
    const { result } = renderHook(() => useSprintScopeChanges('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/scope-changes/');
  });

  it('useSprintDurationChanges fetches duration-change events', async () => {
    getMock.mockResolvedValueOnce({ data: { events: [] } });
    const { result } = renderHook(() => useSprintDurationChanges('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/duration-events/');
  });

  it('useProjectVelocity fetches the last-8 velocity stats', async () => {
    getMock.mockResolvedValueOnce({ data: { sprints: [], excluded_count: 0 } });
    const { result } = renderHook(() => useProjectVelocity('proj-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/velocity/');
  });

  it('useSprintHealth fetches tripped health signals', async () => {
    getMock.mockResolvedValueOnce({ data: { signals: [] } });
    const { result } = renderHook(() => useSprintHealth('proj-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/sprint-health/');
  });

  it('useProjectRetroCarryover unwraps the items array', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [{ action_item_id: 'ai-1' }] } });
    const { result } = renderHook(() => useProjectRetroCarryover('proj-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/retrospective/carryover/');
    expect(result.current.data).toEqual([{ action_item_id: 'ai-1' }]);
  });
});

// ---------------------------------------------------------------------------
// GET reads with an `enabled` gate
// ---------------------------------------------------------------------------

describe('enabled-gated GET reads', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newQc();
    vi.clearAllMocks();
  });

  it('useProjectForecast is suppressed when enabled:false is passed', () => {
    const { result } = renderHook(
      () => useProjectForecast('proj-1', { enabled: false }),
      { wrapper: makeWrapper(qc) },
    );
    expect(result.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('useProjectForecast fetches when enabled defaults to true', async () => {
    getMock.mockResolvedValueOnce({ data: { velocity: {}, remaining_committed_points: 0, milestones: [] } });
    const { result } = renderHook(() => useProjectForecast('proj-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/forecast/');
  });

  it('useSprintForecast fetches the backlog delivery forecast', async () => {
    getMock.mockResolvedValueOnce({ data: { status: 'ready', forecast_basis: 'velocity' } });
    const { result } = renderHook(() => useSprintForecast('proj-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/sprint-forecast/');
  });

  it('useSprintForecast is suppressed when enabled:false', () => {
    const { result } = renderHook(
      () => useSprintForecast('proj-1', { enabled: false }),
      { wrapper: makeWrapper(qc) },
    );
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('useSprintOutcome fetches the consolidated review, suppressed when enabled:false', async () => {
    getMock.mockResolvedValueOnce({ data: { sprint_id: 'sp-1', state: 'COMPLETED' } });
    const { result } = renderHook(() => useSprintOutcome('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/outcome/');

    vi.clearAllMocks();
    const { result: off } = renderHook(
      () => useSprintOutcome('sp-1', { enabled: false }),
      { wrapper: makeWrapper(qc) },
    );
    expect(off.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('useSprintDailyDelta passes a since window when provided, else undefined', async () => {
    getMock.mockResolvedValue({ data: { sprint_id: 'sp-1' } });

    const { result } = renderHook(
      () => useSprintDailyDelta('sp-1', { since: '2026-05-01' }),
      { wrapper: makeWrapper(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/daily-delta/', { params: { since: '2026-05-01' } });

    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: { sprint_id: 'sp-1' } });
    const { result: noSince } = renderHook(() => useSprintDailyDelta('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(noSince.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/daily-delta/', { params: undefined });
  });

  it('useFlowMetrics sends a window param only when supplied', async () => {
    getMock.mockResolvedValue({ data: { window_days: 30 } });

    const { result } = renderHook(
      () => useFlowMetrics('proj-1', { window: 14 }),
      { wrapper: makeWrapper(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/flow-metrics/', { params: { window: 14 } });

    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: { window_days: 30 } });
    const { result: noWin } = renderHook(() => useFlowMetrics('proj-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(noWin.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/flow-metrics/', undefined);
  });

  it('useFlowMetrics is suppressed when enabled:false', () => {
    const { result } = renderHook(
      () => useFlowMetrics('proj-1', { enabled: false }),
      { wrapper: makeWrapper(qc) },
    );
    expect(result.current.fetchStatus).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Sprint-review demo mutations
// ---------------------------------------------------------------------------

describe('sprint-review outcome mutations', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newQc();
    vi.clearAllMocks();
  });

  it('useToggleDemo POSTs the demo flag and invalidates the outcome read', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 'o-1', demo_ready: true } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useToggleDemo('sp-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ outcomeId: 'o-1', demoReady: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprint-task-outcomes/o-1/toggle-demo/', { demo_ready: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sprint', 'sp-1', 'outcome'] });
  });

  it('useReorderDemoList POSTs the full ordered id list', async () => {
    postMock.mockResolvedValueOnce({ data: { updated: 2 } });

    const { result } = renderHook(() => useReorderDemoList('sp-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ outcomeIds: ['o-2', 'o-1'] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/sp-1/demo-list/reorder/', {
      outcome_ids: ['o-2', 'o-1'],
    });
  });

  it('useSetPresenter POSTs the presenter name', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 'o-1', presenter: 'Sam' } });

    const { result } = renderHook(() => useSetPresenter('sp-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ outcomeId: 'o-1', presenter: 'Sam' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprint-task-outcomes/o-1/set-presenter/', { presenter: 'Sam' });
  });

  it('useSetReviewNote POSTs the contributor note', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 'o-1', review_note: 'nice' } });

    const { result } = renderHook(() => useSetReviewNote('sp-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ outcomeId: 'o-1', note: 'nice' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprint-task-outcomes/o-1/set-note/', { note: 'nice' });
  });

  it('useFlagForBacklog POSTs an empty body and invalidates the outcome read', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 'o-1', flagged_to_backlog: true, task_id: 't-1' } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useFlagForBacklog('sp-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ outcomeId: 'o-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprint-task-outcomes/o-1/flag-for-backlog/', {});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sprint', 'sp-1', 'outcome'] });
  });
});

// ---------------------------------------------------------------------------
// Retrospective — reads with 404-to-null translation + writes
// ---------------------------------------------------------------------------

describe('sprint retrospective', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newQc();
    vi.clearAllMocks();
  });

  const fullRetro: SprintRetroResponse = {
    kind: 'full',
    id: 'r-1',
    sprint: 'sp-1',
    notes: 'went well',
    team_visibility: 'team_only',
    created_by: 'u-1',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    action_items: [],
  };

  it('isFullRetro discriminates full vs summary payloads', () => {
    expect(isFullRetro(fullRetro)).toBe(true);
    expect(
      isFullRetro({
        kind: 'summary',
        id: 'r-1',
        sprint: 'sp-1',
        team_visibility: 'team_only',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
        action_items_count: 0,
        promoted_count: 0,
      }),
    ).toBe(false);
  });

  it('useSprintRetro returns the retro payload on success', async () => {
    getMock.mockResolvedValueOnce({ data: fullRetro });
    const { result } = renderHook(() => useSprintRetro('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/retro/');
    expect(result.current.data).toEqual(fullRetro);
  });

  it('useSprintRetro translates a 404 into a null sentinel', async () => {
    getMock.mockRejectedValueOnce(notFound());
    const { result } = renderHook(() => useSprintRetro('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('useSprintRetro rethrows a non-404 error', async () => {
    getMock.mockRejectedValueOnce({ response: { status: 500 } });
    const { result } = renderHook(() => useSprintRetro('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('useSprintRetroPrior translates a 404 into null and fetches otherwise', async () => {
    getMock.mockResolvedValueOnce({ data: fullRetro });
    const { result } = renderHook(() => useSprintRetroPrior('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/sp-1/retrospective/prior/');

    vi.clearAllMocks();
    getMock.mockRejectedValueOnce(notFound());
    const { result: missing } = renderHook(() => useSprintRetroPrior('sp-2'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(missing.current.isSuccess).toBe(true));
    expect(missing.current.data).toBeNull();
  });

  it('useSprintRetroPrior rethrows a non-404 error', async () => {
    getMock.mockRejectedValueOnce({ response: { status: 503 } });
    const { result } = renderHook(() => useSprintRetroPrior('sp-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('useSaveSprintRetro POSTs notes + action items and invalidates the retro read', async () => {
    postMock.mockResolvedValueOnce({ data: fullRetro });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useSaveSprintRetro('sp-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ notes: 'went well', action_items: [{ text: 'do X' }] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/sp-1/retro/', {
      notes: 'went well',
      action_items: [{ text: 'do X' }],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sprint', 'sp-1', 'retro'] });
  });

  it('useUpdateRetroVisibility PATCHes the visibility toggle', async () => {
    patchMock.mockResolvedValueOnce({ data: { ...fullRetro, team_visibility: 'project' } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateRetroVisibility('sp-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate('project');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/sprints/sp-1/retro/', { team_visibility: 'project' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sprint', 'sp-1', 'retro'] });
  });

  it('usePromoteRetroActionItem POSTs and invalidates retro, backlog, tasks, and project', async () => {
    postMock.mockResolvedValueOnce({ data: { task: { id: 't-1' } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => usePromoteRetroActionItem('sp-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate('ai-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/sp-1/retrospective/action-items/ai-1/promote/');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sprint', 'sp-1', 'retro'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sprint-backlog'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project'] });
  });

  it('usePullCarryoverToSprint POSTs the target sprint and invalidates backlog + project', async () => {
    postMock.mockResolvedValueOnce({ data: { task: { id: 't-1' } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => usePullCarryoverToSprint('sp-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ itemId: 'ai-1', targetSprintId: 'sp-2' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith(
      '/sprints/sp-1/retrospective/action-items/ai-1/pull-to-sprint/',
      { target_sprint_id: 'sp-2' },
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sprint-backlog'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project'] });
  });
});

// ---------------------------------------------------------------------------
// TaskSuggestedAssignee action mutations — the three action variants
// ---------------------------------------------------------------------------

describe('suggestion action mutations', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newQc();
    vi.clearAllMocks();
  });

  it('useAcceptSuggestion POSTs to the accept action and invalidates work + tasks', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 's-1', state: 'accepted' } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useAcceptSuggestion(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ taskId: 't-1', suggestionId: 's-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/tasks/t-1/suggestions/s-1/accept/');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me', 'work'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });

  it('useDeclineSuggestion POSTs to the decline action', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 's-1', state: 'declined' } });
    const { result } = renderHook(() => useDeclineSuggestion(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ taskId: 't-1', suggestionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/tasks/t-1/suggestions/s-1/decline/');
  });

  it('useRevokeSuggestion POSTs to the revoke action', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 's-1', state: 'revoked' } });
    const { result } = renderHook(() => useRevokeSuggestion(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ taskId: 't-1', suggestionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/tasks/t-1/suggestions/s-1/revoke/');
  });
});
