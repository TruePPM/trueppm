/**
 * Tests for the useScheduleTasks API mapper (mapTask) and pagination loop.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  mapTask,
  deriveBarGeometry,
  applyTaskDatesDelta,
  useScheduleTasks,
  type ApiTask,
  type TaskDatesDelta,
} from './useScheduleTasks';
import { useWsConnectionStore } from '@/stores/wsConnectionStore';

// ---------------------------------------------------------------------------
// Mocks for hook tests
// ---------------------------------------------------------------------------

const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const base: ApiTask = {
  id: 'abc',
  wbs_path: '1.2',
  name: 'Backend work',
  early_start: '2026-10-05',
  early_finish: '2026-10-15',
  planned_start: null,
  duration: 10,
  percent_complete: 60,
  status: 'IN_PROGRESS',
  is_critical: true,
  is_milestone: false,
  is_summary: false,
  parent_id: null,
  actual_start: null,
  actual_finish: null,
  schedule_variance_days: null,
  baseline_start: null,
  baseline_finish: null,
  late_finish: null,
  optimistic_duration: null,
  most_likely_duration: null,
  pessimistic_duration: null,
  estimate_status: null,
  total_float: null,
  story_points: null,
  remaining_points: null,
};

describe('useScheduleTasks mapper', () => {
  it('maps a normal API task to Task shape', () => {
    const task = mapTask(base);
    expect(task.id).toBe('abc');
    expect(task.wbs).toBe('1.2');
    expect(task.start).toBe('2026-10-05');
    expect(task.isCritical).toBe(true);
    expect(task.isComplete).toBe(false);
    expect(task.isMilestone).toBe(false);
    expect(task.isSummary).toBe(false);
    expect(task.baselineStart).toBeUndefined();
  });

  it('maps the classification taxonomy (type / governance_class / delivery_mode)', () => {
    const task = mapTask({ ...base, type: 'spike', governance_class: 'gated', delivery_mode: 'kanban' });
    expect(task.taskType).toBe('spike');
    expect(task.governanceClass).toBe('gated');
    expect(task.deliveryMode).toBe('kanban');
  });

  it('leaves taxonomy fields undefined on legacy payloads that omit them', () => {
    const task = mapTask(base);
    expect(task.governanceClass).toBeUndefined();
    expect(task.deliveryMode).toBeUndefined();
  });

  it('maps late_finish onto the web Task (issue #1493)', () => {
    const task = mapTask({ ...base, late_finish: '2026-11-01' });
    expect(task.lateFinish).toBe('2026-11-01');
  });

  it('leaves lateFinish undefined before the first CPM run (late_finish null)', () => {
    const task = mapTask(base);
    expect(task.lateFinish).toBeUndefined();
  });

  it('maps server-derived can_edit / can_delete capabilities (ADR-0133)', () => {
    const task = mapTask({ ...base, can_edit: true, can_delete: false });
    expect(task.canEdit).toBe(true);
    expect(task.canDelete).toBe(false);
  });

  it('preserves undefined capabilities on pre-field payloads so the drawer can fall back', () => {
    // A WebSocket-synced row that predates the field must NOT be coerced to false —
    // the drawer's `canEdit ?? canEditTask(role)` fallback depends on undefined.
    const task = mapTask(base);
    expect(task.canEdit).toBeUndefined();
    expect(task.canDelete).toBeUndefined();
  });

  it('uses early_finish for leaf tasks once CPM has produced it', () => {
    const task = mapTask(base);
    expect(task.finish).toBe('2026-10-15');
  });

  it('falls back to start + duration when early_finish is missing (pre-CPM)', () => {
    const task = mapTask({ ...base, early_finish: null });
    // 2026-10-05 + 10 calendar days = 2026-10-15
    expect(task.finish).toBe('2026-10-15');
  });

  it('summary leaf parity: leaf finish matches early_finish so summary roll-up does not visibly extend past its widest child', () => {
    const validate = mapTask({
      ...base,
      id: 'validate',
      early_start: '2026-05-28',
      early_finish: '2026-06-10',
      planned_start: null,
      duration: 10,
    });
    const engSummary = mapTask({
      ...base,
      id: 'eng',
      is_summary: true,
      early_start: '2026-05-11',
      early_finish: '2026-06-10',
      planned_start: null,
      duration: 30,
    });
    expect(validate.finish).toBe(engSummary.finish);
  });

  it('falls back to empty string when CPM has not run (null early_start)', () => {
    const task = mapTask({
      ...base,
      id: 'xyz',
      early_start: null,
      early_finish: null,
      planned_start: null,
      duration: 5,
      percent_complete: 0,
      status: 'NOT_STARTED',
    });
    expect(task.start).toBe('');
    expect(task.finish).toBe('');
  });

  it('marks isComplete when percent_complete is 100', () => {
    expect(mapTask({ ...base, percent_complete: 100 }).isComplete).toBe(true);
  });

  // ---- max(planned_start, early_start) logic ----

  it('uses planned_start when CPM has not run yet (early_start null)', () => {
    const task = mapTask({ ...base, planned_start: '2026-11-01', early_start: null });
    expect(task.start).toBe('2026-11-01');
  });

  it('uses early_start when no SNET constraint (planned_start null)', () => {
    const task = mapTask({ ...base, planned_start: null, early_start: '2026-10-05' });
    expect(task.start).toBe('2026-10-05');
  });

  it('uses early_start when dependency pushes it later than planned_start', () => {
    const task = mapTask({
      ...base,
      planned_start: '2026-10-05',
      early_start: '2026-10-20',
    });
    expect(task.start).toBe('2026-10-20');
  });

  it('uses planned_start right after drag (planned_start > stale early_start)', () => {
    const task = mapTask({
      ...base,
      planned_start: '2026-11-01',
      early_start: '2026-10-05',
    });
    expect(task.start).toBe('2026-11-01');
  });

  it('uses either when planned_start equals early_start', () => {
    const task = mapTask({
      ...base,
      planned_start: '2026-10-05',
      early_start: '2026-10-05',
    });
    expect(task.start).toBe('2026-10-05');
  });

  // ---- actual dates ----

  it('maps actual dates when present', () => {
    const task = mapTask({
      ...base,
      actual_start: '2026-10-06',
      actual_finish: '2026-10-16',
      schedule_variance_days: 1,
    });
    expect(task.actualStart).toBe('2026-10-06');
    expect(task.actualFinish).toBe('2026-10-16');
    expect(task.scheduleVarianceDays).toBe(1);
  });

  it('maps actual dates as undefined when null', () => {
    const task = mapTask(base);
    expect(task.actualStart).toBeUndefined();
    expect(task.actualFinish).toBeUndefined();
    expect(task.scheduleVarianceDays).toBeNull();
  });

  // ---- summary task rollup ----

  it('summary: finish uses early_finish directly (ignores duration)', () => {
    const task = mapTask({
      ...base,
      is_summary: true,
      early_start: '2026-01-06',
      early_finish: '2026-02-06',
      duration: 1,
    });
    expect(task.finish).toBe('2026-02-06');
  });

  it('summary: finish is empty string when CPM has not run yet', () => {
    const task = mapTask({
      ...base,
      is_summary: true,
      early_start: null,
      early_finish: null,
      planned_start: '2026-01-06',
      duration: 5,
    });
    expect(task.finish).toBe('');
  });

  it('summary: duration is computed as calendar-day span from CPM dates', () => {
    const task = mapTask({
      ...base,
      is_summary: true,
      early_start: '2026-01-06',
      early_finish: '2026-02-06',
      duration: 1,
    });
    expect(task.duration).toBe(31);
  });

  it('summary: duration falls back to stored value when CPM has not run', () => {
    const task = mapTask({
      ...base,
      is_summary: true,
      early_start: null,
      early_finish: null,
      duration: 5,
    });
    expect(task.duration).toBe(5);
  });

  it('summary: isSummary is propagated', () => {
    const task = mapTask({ ...base, is_summary: true });
    expect(task.isSummary).toBe(true);
  });

  it('leaf task: finish prefers early_finish (working-day-correct) over start + duration', () => {
    const task = mapTask({
      ...base,
      is_summary: false,
      early_start: '2026-10-05',
      early_finish: '2026-10-20',
      duration: 10,
    });
    expect(task.finish).toBe('2026-10-20');
  });

  // ---- sprint effort fields (issue #366) ----

  it('maps story_points and remaining_points to camelCase', () => {
    const task = mapTask({ ...base, story_points: 8, remaining_points: 5 });
    expect(task.storyPoints).toBe(8);
    expect(task.remainingPoints).toBe(5);
  });

  it('maps null story_points and remaining_points to null', () => {
    const task = mapTask({ ...base, story_points: null, remaining_points: null });
    expect(task.storyPoints).toBeNull();
    expect(task.remainingPoints).toBeNull();
  });

  it('maps absent story_points and remaining_points to null', () => {
    const task = mapTask({ ...base });
    expect(task.storyPoints).toBeNull();
    expect(task.remainingPoints).toBeNull();
  });

  // ---- sprint scope changes + milestone rollup (ADR-0060/#308, ADR-0074) ----
  // These optional payload fields are absent from `base`; without explicit
  // coverage a wire-shape change (renamed key, dropped status default) would
  // pass every test above by coincidence (#849 shape-drift guard).

  it('leaves sprintScopeChanges undefined and milestoneRollup null when the payload omits them', () => {
    const task = mapTask(base);
    expect(task.sprintScopeChanges).toBeUndefined();
    expect(task.milestoneRollup).toBeNull();
  });

  it('maps sprint_scope_changes rows to camelCase, defaulting itemName and goalImpact', () => {
    const task = mapTask({
      ...base,
      sprint_scope_changes: [
        {
          id: 'sc1',
          subtask_name: 'Add retry',
          added_by_name: 'Alex',
          added_at: '2026-10-06T12:00:00Z',
          status: 'pending',
        },
      ],
    });
    expect(task.sprintScopeChanges).toEqual([
      {
        id: 'sc1',
        subtaskName: 'Add retry',
        // itemName falls back to subtask_name when item_name is absent.
        itemName: 'Add retry',
        addedByName: 'Alex',
        addedAt: '2026-10-06T12:00:00Z',
        goalImpact: false,
        status: 'pending',
      },
    ]);
  });

  it('treats legacy scope-change rows with no status as accepted (never resurface as pending)', () => {
    const task = mapTask({
      ...base,
      sprint_scope_changes: [
        {
          subtask_name: 'Legacy item',
          item_name: 'Legacy item (full)',
          added_by_name: null,
          added_at: '2026-10-01T00:00:00Z',
        },
      ],
    });
    expect(task.sprintScopeChanges?.[0].status).toBe('accepted');
    expect(task.sprintScopeChanges?.[0].itemName).toBe('Legacy item (full)');
    expect(task.sprintScopeChanges?.[0].addedByName).toBeNull();
  });

  it('passes milestone_rollup through unchanged when present', () => {
    const rollup = {
      percent_complete: 42,
      rollup_basis: 'points' as const,
      variance_days: -3,
      sprint_scope_changed: true,
      scope_change_sprint_id: 'spr-1',
      sprint_count: 2,
    };
    const task = mapTask({ ...base, is_milestone: true, milestone_rollup: rollup });
    expect(task.milestoneRollup).toEqual(rollup);
  });
});

// ---------------------------------------------------------------------------
// Hook: pagination loop
// ---------------------------------------------------------------------------

function makeApiTask(id: string): ApiTask {
  return { ...base, id, wbs_path: null };
}

function paginatedResponse(results: ApiTask[], next: string | null = null) {
  return { data: { results, next, previous: null, count: results.length } };
}

// A count-driven fake server (issue 1519). The hook derives the full page set
// from `count` (not the `next` cursor), so `count` can advertise more rows than
// any single page returns; each `page` param selects that page's slice. This
// lets us exercise the multi-page parallel walk without materializing 200+ rows.
type GetConfig = { params?: Record<string, unknown> };

// Extract the request params from a recorded getMock call (call[1] is the axios
// config). Typed so the assertions stay free of `any`-unsafe member access.
function callParams(call: unknown[]): Record<string, unknown> {
  return (call[1] as GetConfig | undefined)?.params ?? {};
}
function countDrivenGet<T>(
  path: string,
  total: number,
  pages: Record<number, T[]>,
): (url: string, config?: GetConfig) => Promise<{ data: unknown }> {
  return (url: string, config?: GetConfig) => {
    if (url !== path) {
      return Promise.resolve({ data: { results: [], next: null, previous: null, count: 0 } });
    }
    const page = Number(config?.params?.page ?? 1);
    return Promise.resolve({
      data: { results: pages[page] ?? [], next: null, previous: null, count: total },
    });
  };
}

describe('useScheduleTasks pagination', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getMock.mockReset();
    // Stub the dependencies query so it doesn't interfere.
    getMock.mockImplementation((url: string) => {
      if (url === '/dependencies/') return Promise.resolve(paginatedResponse([]));
      return Promise.resolve(paginatedResponse([]));
    });
  });

  it('fetches a single page when next is null', async () => {
    const task = makeApiTask('t-1');
    getMock.mockImplementation((url: string) => {
      if (url === '/dependencies/') return Promise.resolve(paginatedResponse([]));
      return Promise.resolve(paginatedResponse([task], null));
    });

    const { result } = renderHook(() => useScheduleTasks('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks![0].id).toBe('t-1');
  });

  it('fetches remaining pages in parallel and concatenates in page order (issue 1519)', async () => {
    // count=450 with page_size=200 → 3 pages. Serve distinct slices per page.
    const page1 = [makeApiTask('t-1'), makeApiTask('t-2')];
    const page2 = [makeApiTask('t-3'), makeApiTask('t-4')];
    const page3 = [makeApiTask('t-5')];
    getMock.mockImplementation(
      countDrivenGet('/tasks/', 450, { 1: page1, 2: page2, 3: page3 }),
    );

    const { result } = renderHook(() => useScheduleTasks('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Order preserved across the parallel fetch: page1 ++ page2 ++ page3.
    expect(result.current.tasks!.map((t) => t.id)).toEqual([
      't-1',
      't-2',
      't-3',
      't-4',
      't-5',
    ]);
  });

  it('requests page 1 at page_size=200 and the remainder by explicit page number', async () => {
    getMock.mockImplementation(
      countDrivenGet('/tasks/', 450, {
        1: [makeApiTask('t-1')],
        2: [makeApiTask('t-2')],
        3: [makeApiTask('t-3')],
      }),
    );

    const { result } = renderHook(() => useScheduleTasks('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const taskCalls = getMock.mock.calls.filter(([url]) => url === '/tasks/');
    // Page 1: large page_size, no explicit page param.
    expect(callParams(taskCalls[0])).toEqual({ project: 'proj-1', page_size: 200 });
    // Remaining pages requested by number (parallel dispatch — all three total).
    const requestedPages = taskCalls
      .map((c) => callParams(c).page)
      .filter(Boolean)
      .sort();
    expect(requestedPages).toEqual([2, 3]);
    expect(taskCalls).toHaveLength(3);
  });

  it('fetches a single page when count fits in one page (no page param)', async () => {
    getMock.mockImplementation(
      countDrivenGet('/tasks/', 1, { 1: [makeApiTask('t-1')] }),
    );

    const { result } = renderHook(() => useScheduleTasks('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.tasks).toHaveLength(1);
    const taskCalls = getMock.mock.calls.filter(([url]) => url === '/tasks/');
    expect(taskCalls).toHaveLength(1);
    expect(callParams(taskCalls[0]).page).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hook: dependency-links pagination (#773)
// ---------------------------------------------------------------------------

function makeApiDep(id: string) {
  return {
    id,
    predecessor: 'p-' + id,
    successor: 's-' + id,
    dep_type: 'FS' as const,
    lag: 0,
  };
}

function depPage(results: ReturnType<typeof makeApiDep>[], next: string | null = null) {
  return { data: { results, next, previous: null, count: results.length } };
}

describe('useScheduleTasks dependency pagination (#773)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getMock.mockReset();
  });

  it('fetches remaining dependency pages in parallel and preserves order (issue 1519)', async () => {
    const depPage1 = [makeApiDep('d-1'), makeApiDep('d-2')];
    const depPage2 = [makeApiDep('d-3')];
    // count=250 with page_size=200 → 2 pages.
    getMock.mockImplementation(
      countDrivenGet('/dependencies/', 250, { 1: depPage1, 2: depPage2 }),
    );

    const { result } = renderHook(() => useScheduleTasks('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.links).toHaveLength(3);
    expect(result.current.links!.map((l) => l.id)).toEqual(['d-1', 'd-2', 'd-3']);
  });

  it('requests dependency pages by explicit page number (page 1 at page_size=200)', async () => {
    getMock.mockImplementation(
      countDrivenGet('/dependencies/', 250, {
        1: [makeApiDep('d-1')],
        2: [makeApiDep('d-2')],
      }),
    );

    const { result } = renderHook(() => useScheduleTasks('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const depCalls = getMock.mock.calls.filter(([url]) => url === '/dependencies/');
    expect(callParams(depCalls[0])).toEqual({ project: 'proj-1', page_size: 200 });
    expect(depCalls.map((c) => callParams(c).page).filter(Boolean)).toEqual([2]);
    expect(depCalls).toHaveLength(2);
  });

  it('derives link isCritical from endpoint task criticality (the API has no is_critical on deps)', async () => {
    const a = { ...base, id: 'a', is_critical: true };
    const b = { ...base, id: 'b', is_critical: true };
    const c = { ...base, id: 'c', is_critical: false };
    // dc: both endpoints critical → critical edge. dm: one endpoint non-critical → not.
    const dc = { id: 'dc', predecessor: 'a', successor: 'b', dep_type: 'FS' as const, lag: 0 };
    const dm = { id: 'dm', predecessor: 'a', successor: 'c', dep_type: 'FS' as const, lag: 0 };

    getMock.mockImplementation((url: string) => {
      if (url === '/tasks/') return Promise.resolve(paginatedResponse([a, b, c]));
      if (url === '/dependencies/') return Promise.resolve(depPage([dc, dm]));
      return Promise.resolve(paginatedResponse([]));
    });

    const { result } = renderHook(() => useScheduleTasks('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const byId = Object.fromEntries(
      result.current.links!.map((l) => [l.id, l.isCritical]),
    );
    expect(byId['dc']).toBe(true);
    expect(byId['dm']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hook: fallback polling gated on WS connection state (#773)
// ---------------------------------------------------------------------------

describe('useScheduleTasks fallback polling gate (#773)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getMock.mockReset();
    getMock.mockImplementation(() => Promise.resolve(paginatedResponse([])));
    // Reset the connection store to a known state between tests.
    useWsConnectionStore.getState().markConnecting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Count GET calls to the tasks endpoint (first page of the tasks query). */
  function tasksFetchCount() {
    return getMock.mock.calls.filter(([url]) => url === '/tasks/').length;
  }

  it('does NOT poll the tasks query while the WebSocket is live', async () => {
    useWsConnectionStore.getState().markLive();

    renderHook(() => useScheduleTasks('proj-1'), { wrapper: makeWrapper(qc) });

    await vi.waitFor(() => expect(tasksFetchCount()).toBe(1));
    const initial = tasksFetchCount();

    // Advance well past two 30 s windows — no extra fetch should occur.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000);
    });
    expect(tasksFetchCount()).toBe(initial);
  });

  it('polls the tasks query as a fallback when the WebSocket is disconnected', async () => {
    // Three retryable drops → `stale` (not `live`), so polling is armed.
    const store = useWsConnectionStore.getState();
    store.markDisconnected();
    store.markDisconnected();
    store.markDisconnected();
    expect(useWsConnectionStore.getState().state).toBe('stale');

    renderHook(() => useScheduleTasks('proj-1'), { wrapper: makeWrapper(qc) });

    await vi.waitFor(() => expect(tasksFetchCount()).toBe(1));
    const initial = tasksFetchCount();

    // One 30 s window should trigger at least one fallback refetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    await vi.waitFor(() => expect(tasksFetchCount()).toBeGreaterThan(initial));
  });
});

// ---------------------------------------------------------------------------
// deriveBarGeometry — shared bar-positioning rules (ADR-0091)
// ---------------------------------------------------------------------------

describe('deriveBarGeometry', () => {
  it('uses the later of planned_start (SNET) and early_start', () => {
    // planned_start later than early_start → planned_start wins (pre-CPM drag).
    expect(
      deriveBarGeometry({
        plannedStart: '2026-10-10',
        earlyStart: '2026-10-05',
        earlyFinish: '2026-10-15',
        duration: 10,
        isSummary: false,
      }).start,
    ).toBe('2026-10-10');
    // early_start later (CPM pushed it) → early_start wins.
    expect(
      deriveBarGeometry({
        plannedStart: '2026-10-01',
        earlyStart: '2026-10-05',
        earlyFinish: '2026-10-15',
        duration: 10,
        isSummary: false,
      }).start,
    ).toBe('2026-10-05');
  });

  it('falls back to start + duration for a leaf with no early_finish yet', () => {
    const g = deriveBarGeometry({
      plannedStart: '2026-10-05',
      earlyStart: null,
      earlyFinish: null,
      duration: 4,
      isSummary: false,
    });
    expect(g.start).toBe('2026-10-05');
    expect(g.finish).toBe('2026-10-09');
  });

  it('computes a summary display duration as the calendar-day span', () => {
    const g = deriveBarGeometry({
      plannedStart: null,
      earlyStart: '2026-10-05',
      earlyFinish: '2026-10-15',
      duration: 99, // stored value ignored for summaries with CPM dates
      isSummary: true,
    });
    expect(g.displayDuration).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// applyTaskDatesDelta — WebSocket CPM delta splice (ADR-0091)
// ---------------------------------------------------------------------------

describe('applyTaskDatesDelta', () => {
  const delta: TaskDatesDelta = {
    id: 'abc',
    early_start: '2026-11-02',
    early_finish: '2026-11-12',
    late_start: '2026-11-05',
    late_finish: '2026-11-15',
    total_float: 3,
    free_float: 1,
    is_critical: false,
    planned_start: null,
    duration: 10,
  };

  it('produces the same bar fields a full re-fetch would (parity with mapTask)', () => {
    const existing = mapTask(base);
    const spliced = applyTaskDatesDelta(existing, delta);

    const refetched = mapTask({
      ...base,
      early_start: delta.early_start,
      early_finish: delta.early_finish,
      total_float: delta.total_float,
      late_finish: delta.late_finish,
      is_critical: delta.is_critical,
      planned_start: delta.planned_start,
      duration: delta.duration,
    });

    expect(spliced.start).toBe(refetched.start);
    expect(spliced.finish).toBe(refetched.finish);
    expect(spliced.duration).toBe(refetched.duration);
    expect(spliced.isCritical).toBe(refetched.isCritical);
    expect(spliced.totalFloat).toBe(refetched.totalFloat);
    expect(spliced.lateFinish).toBe(refetched.lateFinish);
    expect(spliced.plannedStart).toBe(refetched.plannedStart);
  });

  it('splices late_finish so the drag preview stays fresh after a CPM re-run (issue #1493)', () => {
    const existing = mapTask(base); // lateFinish undefined (base.late_finish = null)
    const spliced = applyTaskDatesDelta(existing, delta);
    expect(spliced.lateFinish).toBe('2026-11-15');
  });

  it('preserves every non-CPM field of the existing task', () => {
    const existing = mapTask(base);
    const spliced = applyTaskDatesDelta(existing, delta);

    expect(spliced.id).toBe(existing.id);
    expect(spliced.name).toBe(existing.name);
    expect(spliced.progress).toBe(existing.progress);
    expect(spliced.status).toBe(existing.status);
    expect(spliced.wbs).toBe(existing.wbs);
    expect(spliced.assignees).toEqual(existing.assignees);
  });

  it('flips the bar to the new dates and criticality', () => {
    const existing = mapTask(base); // base.is_critical = true, early_start 2026-10-05
    const spliced = applyTaskDatesDelta(existing, delta);

    expect(existing.isCritical).toBe(true);
    expect(spliced.isCritical).toBe(false); // delta cleared criticality
    expect(spliced.start).toBe('2026-11-02');
    expect(spliced.finish).toBe('2026-11-12');
    expect(spliced.totalFloat).toBe(3);
  });

  it('does not mutate the input task', () => {
    const existing = mapTask(base);
    const snapshot = { ...existing };
    applyTaskDatesDelta(existing, delta);
    expect(existing).toEqual(snapshot);
  });
});
