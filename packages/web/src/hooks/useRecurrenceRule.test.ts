import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useCreateRecurrenceRule,
  useDeleteRecurrenceRule,
  useRecurrenceRule,
  useUpdateRecurrenceRule,
  type TaskRecurrenceRule,
} from './useRecurrenceRule';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));

const RULE = {
  id: 'rr1',
  server_version: 1,
  task: 't1',
  frequency: 'WEEKLY',
  interval: 1,
  weekdays: 1,
  day_of_month: null,
  time_of_day: '09:00:00',
  timezone: 'UTC',
  end_type: 'NEVER',
  end_date: null,
} as unknown as TaskRecurrenceRule;

let qc: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  [getMock, postMock, patchMock, deleteMock].forEach((m) => m.mockReset());
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
});

describe('useRecurrenceRule', () => {
  it('unwraps the single-row page to the rule, scoped by task and project', async () => {
    getMock.mockResolvedValue({ data: { count: 1, next: null, previous: null, results: [RULE] } });
    const { result } = renderHook(() => useRecurrenceRule('p1', 't1'), { wrapper });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.rule).toEqual(RULE));
    expect(getMock).toHaveBeenCalledWith('/recurrence-rules/', {
      params: { task: 't1', project: 'p1' },
    });
    expect(result.current.error).toBeNull();
  });

  it('reads an empty page as "no rule" rather than an error', async () => {
    getMock.mockResolvedValue({ data: { count: 0, next: null, previous: null, results: [] } });
    const { result } = renderHook(() => useRecurrenceRule('p1', 't1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rule).toBeNull();
  });

  it('stays idle without a task or a project', () => {
    renderHook(() => useRecurrenceRule('p1', null), { wrapper });
    renderHook(() => useRecurrenceRule('', 't1'), { wrapper });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('recurrence rule mutations', () => {
  it("create posts the input and invalidates the created rule's task", async () => {
    postMock.mockResolvedValue({ data: RULE });
    const { result } = renderHook(() => useCreateRecurrenceRule(), { wrapper });
    const input = { task: 't1', frequency: 'WEEKLY' } as unknown as Parameters<
      typeof result.current.mutateAsync
    >[0];
    await act(async () => {
      await result.current.mutateAsync(input);
    });
    expect(postMock).toHaveBeenCalledWith('/recurrence-rules/', input);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task-recurrence-rule', 't1'] });
  });

  it('update patches by rule id and invalidates by the task id it was given', async () => {
    patchMock.mockResolvedValue({ data: RULE });
    const { result } = renderHook(() => useUpdateRecurrenceRule(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ ruleId: 'rr1', taskId: 't1', patch: { interval: 2 } });
    });
    expect(patchMock).toHaveBeenCalledWith('/recurrence-rules/rr1/', { interval: 2 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task-recurrence-rule', 't1'] });
  });

  it('delete removes by rule id and invalidates the task', async () => {
    deleteMock.mockResolvedValue({});
    const { result } = renderHook(() => useDeleteRecurrenceRule(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ ruleId: 'rr1', taskId: 't1' });
    });
    expect(deleteMock).toHaveBeenCalledWith('/recurrence-rules/rr1/');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task-recurrence-rule', 't1'] });
  });
});
