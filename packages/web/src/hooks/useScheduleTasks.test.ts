/**
 * Tests for the useScheduleTasks API mapper (mapTask) and pagination loop.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { mapTask, useScheduleTasks, type ApiTask } from './useScheduleTasks';

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

  it('follows the next cursor and accumulates all pages', async () => {
    const page1 = [makeApiTask('t-1'), makeApiTask('t-2')];
    const page2 = [makeApiTask('t-3')];

    getMock.mockImplementation((url: string) => {
      if (url === '/dependencies/') return Promise.resolve(paginatedResponse([]));
      if (url === '/tasks/') return Promise.resolve(paginatedResponse(page1, 'http://api/tasks/?cursor=abc'));
      if (url === '/tasks/?cursor=abc') return Promise.resolve(paginatedResponse(page2, null));
      return Promise.resolve(paginatedResponse([]));
    });

    const { result } = renderHook(() => useScheduleTasks('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.tasks).toHaveLength(3);
    expect(result.current.tasks!.map((t) => t.id)).toEqual(['t-1', 't-2', 't-3']);
  });

  it('strips the origin from the next URL', async () => {
    const task = makeApiTask('t-1');
    getMock.mockImplementation((url: string) => {
      if (url === '/dependencies/') return Promise.resolve(paginatedResponse([]));
      if (url === '/tasks/') {
        return Promise.resolve(
          paginatedResponse([task], 'https://api.trueppm.com/tasks/?cursor=xyz'),
        );
      }
      if (url === '/tasks/?cursor=xyz') return Promise.resolve(paginatedResponse([], null));
      return Promise.resolve(paginatedResponse([]));
    });

    const { result } = renderHook(() => useScheduleTasks('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Both calls should have been made via apiClient (origin stripped).
    expect(getMock).toHaveBeenCalledWith('/tasks/?cursor=xyz', expect.anything());
  });
});
