import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';
import { act } from 'react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  applyCellEdit,
  useTimesheetCell,
  useSubmitWeek,
  weekTimesheetKey,
  type CellEditVars,
  type CellTaskMeta,
} from './useWeekTimesheet';
import type { WeeklyEntry, WeeklyResponse } from '@/features/timesheet/weekModel';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));

const toastInfo = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/components/Toast', () => ({
  toast: { info: toastInfo, error: toastError },
}));

const META: CellTaskMeta = {
  taskId: 'task-a',
  taskShortId: 'RIV-1',
  taskName: 'Foundation',
  projectId: 'proj-1',
  projectCode: 'RIV',
  projectName: 'Riverside',
};

function entry(over: Partial<WeeklyEntry>): WeeklyEntry {
  return {
    id: 'e1',
    task: 'task-a',
    task_short_id: 'RIV-1',
    task_name: 'Foundation',
    project: 'proj-1',
    project_code: 'RIV',
    project_name: 'Riverside',
    minutes: 60,
    entry_date: '2026-06-15',
    note: '',
    source: 'manual',
    server_version: 1,
    created_at: '2026-06-15T10:00:00Z',
    ...over,
  };
}

function response(results: WeeklyEntry[]): WeeklyResponse {
  return {
    results,
    totals: { by_day: {}, by_cell: {}, today_minutes: 0, week_minutes: 0 },
    submission: { week_start: '2026-06-15', submitted: false, submitted_at: null },
  };
}

describe('applyCellEdit (pure optimistic transform)', () => {
  it('patches an existing entry and recomputes totals', () => {
    const prev = response([entry({ id: 'e1', minutes: 60 })]);
    const vars: CellEditVars = { meta: META, date: '2026-06-15', minutes: 120, entryId: 'e1' };
    const next = applyCellEdit(prev, vars);
    expect(next.results[0].minutes).toBe(120);
    expect(next.totals.week_minutes).toBe(120);
  });

  it('removes an entry when cleared to 0', () => {
    const prev = response([entry({ id: 'e1', minutes: 60 })]);
    const next = applyCellEdit(prev, { meta: META, date: '2026-06-15', minutes: 0, entryId: 'e1' });
    expect(next.results).toHaveLength(0);
    expect(next.totals.week_minutes).toBe(0);
  });

  it('appends an optimistic entry on create', () => {
    const prev = response([]);
    const next = applyCellEdit(prev, { meta: META, date: '2026-06-16', minutes: 90, entryId: null });
    expect(next.results).toHaveLength(1);
    expect(next.results[0].minutes).toBe(90);
    expect(next.results[0].task).toBe('task-a');
    expect(next.totals.week_minutes).toBe(90);
  });

  it('is a no-op creating an empty cell', () => {
    const prev = response([entry({ id: 'e1', minutes: 60 })]);
    const next = applyCellEdit(prev, { meta: META, date: '2026-06-16', minutes: 0, entryId: null });
    expect(next.results).toHaveLength(1);
  });
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(weekTimesheetKey('2026-06-15'), response([entry({ id: 'e1', minutes: 60 })]));
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return { qc, Wrapper };
}

describe('useTimesheetCell endpoint mapping', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset().mockResolvedValue({ data: {} });
    patchMock.mockReset().mockResolvedValue({ data: {} });
    deleteMock.mockReset().mockResolvedValue({ data: {} });
  });

  it('PATCHes when an entry exists and minutes > 0', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useTimesheetCell('2026-06-15'), { wrapper: Wrapper });
    result.current.mutate({ meta: META, date: '2026-06-15', minutes: 120, entryId: 'e1' });
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('/me/time-entries/e1/', { minutes: 120 }));
    expect(postMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('DELETEs when an entry is cleared to 0', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useTimesheetCell('2026-06-15'), { wrapper: Wrapper });
    result.current.mutate({ meta: META, date: '2026-06-15', minutes: 0, entryId: 'e1' });
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/me/time-entries/e1/'));
  });

  it('POSTs a new entry when the cell is empty', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useTimesheetCell('2026-06-15'), { wrapper: Wrapper });
    result.current.mutate({ meta: META, date: '2026-06-16', minutes: 90, entryId: null });
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/tasks/task-a/time-entries/', {
        minutes: 90,
        entry_date: '2026-06-16',
      }),
    );
  });

  it('rolls the cache back on error', async () => {
    const { qc, Wrapper } = wrapper();
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useTimesheetCell('2026-06-15'), { wrapper: Wrapper });
    result.current.mutate({ meta: META, date: '2026-06-15', minutes: 999, entryId: 'e1' });
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const cached = qc.getQueryData<WeeklyResponse>(weekTimesheetKey('2026-06-15'));
    expect(cached?.results[0].minutes).toBe(60); // restored
  });
});

describe('offline cell writes (#1949)', () => {
  beforeEach(() => {
    getMock.mockReset().mockResolvedValue({ data: response([]) });
    postMock.mockReset().mockResolvedValue({ data: { id: 'real-1' } });
    patchMock.mockReset().mockResolvedValue({ data: {} });
    deleteMock.mockReset().mockResolvedValue({ data: {} });
  });
  afterEach(() => onlineManager.setOnline(true));

  /** What the page does: read the cell's entry id from the (optimistic) cache. */
  function cellEntryId(qc: QueryClient): string | null {
    const cur = qc.getQueryData<WeeklyResponse>(weekTimesheetKey('2026-06-15'));
    return cur?.results.find((e) => e.task === META.taskId && e.entry_date === '2026-06-16')?.id ?? null;
  }

  it('sends the write exactly once on reconnect', async () => {
    const { qc, Wrapper } = wrapper();
    onlineManager.setOnline(false);
    const { result } = renderHook(() => useTimesheetCell('2026-06-15'), { wrapper: Wrapper });
    act(() => {
      result.current.mutate({ meta: META, date: '2026-06-16', minutes: 90, entryId: null });
    });
    await waitFor(() => expect(cellEntryId(qc)).not.toBeNull());
    expect(postMock).not.toHaveBeenCalled();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/tasks/task-a/time-entries/', { minutes: 90, entry_date: '2026-06-16' });
  });

  it('a second offline edit of a new cell does not PATCH a placeholder id or double-create', async () => {
    const { qc, Wrapper } = wrapper();
    onlineManager.setOnline(false);
    const { result } = renderHook(() => useTimesheetCell('2026-06-15'), { wrapper: Wrapper });
    act(() => {
      result.current.mutate({ meta: META, date: '2026-06-16', minutes: 90, entryId: null });
    });
    await waitFor(() => expect(cellEntryId(qc)).not.toBeNull());
    act(() => {
      result.current.mutate({ meta: META, date: '2026-06-16', minutes: 120, entryId: cellEntryId(qc) });
    });
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    // No request may target the client-side placeholder id, and the cell is created once.
    expect(patchMock.mock.calls.filter(([url]) => String(url).includes('optimistic-'))).toHaveLength(0);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith('/tasks/task-a/time-entries/', { minutes: 90, entry_date: '2026-06-16' });
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('/me/time-entries/real-1/', { minutes: 120 }));
  });
});

describe('sequential fill-across writes through the real hook (#1950)', () => {
  beforeEach(() => {
    postMock.mockReset();
    toastError.mockReset();
  });

  it('rolls back only the rejected cell; successful cells keep their values', async () => {
    const { qc, Wrapper } = wrapper();
    const rejection = new AxiosError('Request failed with status code 400');
    rejection.response = { status: 400, data: { entry_date: ['Task is closed.'] } } as AxiosResponse;
    postMock
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ data: {} });
    const { result } = renderHook(() => useTimesheetCell('2026-06-15'), { wrapper: Wrapper });
    const outcomes: boolean[] = [];
    for (const date of ['2026-06-16', '2026-06-17', '2026-06-18']) {
      await act(async () => {
        try {
          await result.current.mutateAsync({ meta: META, date, minutes: 120, entryId: null });
          outcomes.push(true);
        } catch {
          outcomes.push(false);
        }
      });
    }
    expect(outcomes).toEqual([true, false, true]);
    const dates = (qc.getQueryData<WeeklyResponse>(weekTimesheetKey('2026-06-15'))?.results ?? [])
      .map((e) => e.entry_date)
      .sort();
    // Source cell and both successful writes survive; only the rejected 06-17 is gone.
    expect(dates).toEqual(['2026-06-15', '2026-06-16', '2026-06-18']);
    // A 4xx is shown inline by the page, so the hook adds no toast for it.
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('useSubmitWeek', () => {
  beforeEach(() => {
    postMock.mockReset().mockResolvedValue({ data: {} });
    deleteMock.mockReset().mockResolvedValue({ data: {} });
    toastInfo.mockReset();
    toastError.mockReset();
  });

  const REOPEN = 'This week is approved. An approved week cannot be reopened.';
  const RESUBMIT = 'This week is approved, so it cannot be submitted again.';
  const GENERIC = 'Could not update the week. Please try again.';

  it.each([
    ['timesheet_state_conflict', false, REOPEN],
    ['timesheet_week_approved', false, REOPEN],
    ['timesheet_state_conflict', true, RESUBMIT],
    ['something_else', false, GENERIC],
  ])('reports a %s refusal honestly (submit=%s)', async (code, submit, message) => {
    const refusal = new AxiosError('conflict', undefined, undefined, undefined, {
      status: 409,
      data: { detail: 'refused', code },
    } as AxiosResponse);
    postMock.mockRejectedValue(refusal);
    deleteMock.mockRejectedValue(refusal);
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useSubmitWeek('2026-06-15'), { wrapper: Wrapper });
    result.current.mutate(submit);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(message));
  });

  it('POSTs to submit the week', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useSubmitWeek('2026-06-15'), { wrapper: Wrapper });
    result.current.mutate(true);
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/me/timesheets/2026-06-15/submit/'));
    expect(toastInfo).toHaveBeenCalledWith('Week submitted.');
  });

  it('DELETEs to reopen the week', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useSubmitWeek('2026-06-15'), { wrapper: Wrapper });
    result.current.mutate(false);
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/me/timesheets/2026-06-15/submit/'));
  });
});
