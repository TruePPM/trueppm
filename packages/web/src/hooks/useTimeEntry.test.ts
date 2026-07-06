import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  todayIso,
  useCreateTimeEntry,
  useDeleteTimeEntry,
  useTimeRollup,
} from './useTimeEntry';
import { weekTimesheetKey } from './useWeekTimesheet';
import { mondayOf, type WeeklyEntry, type WeeklyResponse } from '@/features/timesheet/weekModel';

const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, delete: deleteMock },
}));

const TODAY = todayIso();
const MONDAY = mondayOf(TODAY);

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
    entry_date: TODAY,
    note: '',
    source: 'manual',
    server_version: 1,
    created_at: `${TODAY}T10:00:00Z`,
    ...over,
  };
}

function response(results: WeeklyEntry[]): WeeklyResponse {
  return {
    results,
    totals: {
      by_day: { [TODAY]: results.reduce((s, e) => s + e.minutes, 0) },
      by_cell: Object.fromEntries(results.map((e) => [`${e.task}|${e.entry_date}`, e.minutes])),
      today_minutes: results.reduce((s, e) => s + e.minutes, 0),
      week_minutes: results.reduce((s, e) => s + e.minutes, 0),
    },
    submission: { week_start: MONDAY, submitted: false, submitted_at: null },
  };
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return { qc, wrapper };
}

const CREATE_VARS = {
  taskId: 'task-a',
  taskShortId: 'RIV-1',
  taskName: 'Foundation',
  projectId: 'proj-1',
  projectName: 'Riverside',
  minutes: 30,
  entryDate: TODAY,
  note: '',
};

beforeEach(() => {
  postMock.mockReset();
  deleteMock.mockReset();
  getMock.mockReset();
});

describe('useCreateTimeEntry', () => {
  it('optimistically adds the entry and recomputes totals, then reconciles', async () => {
    const { qc, wrapper } = makeWrapper();
    qc.setQueryData(weekTimesheetKey(MONDAY), response([entry({ id: 'e1', minutes: 60 })]));
    postMock.mockResolvedValue({ data: { id: 'server-1', minutes: 30, entry_date: TODAY } });

    const { result } = renderHook(() => useCreateTimeEntry(), { wrapper });
    result.current.mutate(CREATE_VARS);

    // Optimistic write lands before the request resolves: 60 + 30 = 90 today.
    await waitFor(() => {
      const cached = qc.getQueryData<WeeklyResponse>(weekTimesheetKey(MONDAY));
      expect(cached?.totals.today_minutes).toBe(90);
      expect(cached?.results).toHaveLength(2);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/tasks/task-a/time-entries/', {
      minutes: 30,
      entry_date: TODAY,
      note: '',
    });
  });

  it('rolls back the optimistic write when the server rejects', async () => {
    const { qc, wrapper } = makeWrapper();
    const snapshot = response([entry({ id: 'e1', minutes: 60 })]);
    qc.setQueryData(weekTimesheetKey(MONDAY), snapshot);
    postMock.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useCreateTimeEntry(), { wrapper });
    result.current.mutate(CREATE_VARS);

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<WeeklyResponse>(weekTimesheetKey(MONDAY));
    expect(cached?.totals.today_minutes).toBe(60);
    expect(cached?.results).toHaveLength(1);
  });
});

describe('useDeleteTimeEntry', () => {
  it('optimistically removes the entry and recomputes totals', async () => {
    const { qc, wrapper } = makeWrapper();
    qc.setQueryData(
      weekTimesheetKey(MONDAY),
      response([entry({ id: 'keep', minutes: 60 }), entry({ id: 'gone', minutes: 30 })]),
    );
    deleteMock.mockResolvedValue({});

    const { result } = renderHook(() => useDeleteTimeEntry(), { wrapper });
    result.current.mutate({ entryId: 'gone', entryDate: TODAY });

    await waitFor(() => {
      const cached = qc.getQueryData<WeeklyResponse>(weekTimesheetKey(MONDAY));
      expect(cached?.results.map((e) => e.id)).toEqual(['keep']);
      expect(cached?.totals.today_minutes).toBe(60);
    });
    expect(deleteMock).toHaveBeenCalledWith('/me/time-entries/gone/');
  });

  it('restores the entry when the delete fails', async () => {
    const { qc, wrapper } = makeWrapper();
    qc.setQueryData(weekTimesheetKey(MONDAY), response([entry({ id: 'gone', minutes: 30 })]));
    deleteMock.mockRejectedValue(new Error('nope'));

    const { result } = renderHook(() => useDeleteTimeEntry(), { wrapper });
    result.current.mutate({ entryId: 'gone', entryDate: TODAY });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<WeeklyResponse>(weekTimesheetKey(MONDAY));
    expect(cached?.results).toHaveLength(1);
    expect(cached?.totals.today_minutes).toBe(30);
  });
});

describe('useTimeRollup', () => {
  it('exposes today/week totals and per-task logged-today from the week query', async () => {
    const { wrapper } = makeWrapper();
    getMock.mockResolvedValue({
      data: response([entry({ id: 'e1', task: 'task-a', minutes: 90 })]),
    });

    const { result } = renderHook(() => useTimeRollup(), { wrapper });

    await waitFor(() => expect(result.current.weekMinutes).toBe(90));
    expect(result.current.todayMinutes).toBe(90);
    expect(result.current.loggedTodayForTask('task-a')).toBe(90);
    expect(result.current.loggedTodayForTask('task-other')).toBe(0);
  });
});
