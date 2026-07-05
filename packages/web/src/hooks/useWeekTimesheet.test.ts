import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
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

describe('useSubmitWeek', () => {
  beforeEach(() => {
    postMock.mockReset().mockResolvedValue({ data: {} });
    deleteMock.mockReset().mockResolvedValue({ data: {} });
    toastInfo.mockReset();
  });

  it('POSTs to submit the week', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useSubmitWeek('2026-06-15'), { wrapper: Wrapper });
    result.current.mutate(true);
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/me/timesheets/2026-06-15/submit'));
    expect(toastInfo).toHaveBeenCalledWith('Week submitted.');
  });

  it('DELETEs to reopen the week', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useSubmitWeek('2026-06-15'), { wrapper: Wrapper });
    result.current.mutate(false);
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/me/timesheets/2026-06-15/submit'));
  });
});
