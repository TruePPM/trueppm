import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  BACKOFF_OPTIONS,
  useDropAllFailedTasks,
  useDropFailedTask,
  useRequeueAllFailedTasks,
  useRequeueFailedTask,
} from './useFailedTaskActions';

const postMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { post: postMock } }));

let qc: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  postMock.mockReset();
  postMock.mockResolvedValue({ data: { processed: 3, matched: 5, capped: true } });
  qc = new QueryClient();
  invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
});

describe('failed-task operator actions', () => {
  it('requeue one posts the backoff and refreshes the inspector', async () => {
    const { result } = renderHook(() => useRequeueFailedTask(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'ft1', backoffSeconds: 300 });
    });
    expect(postMock).toHaveBeenCalledWith('/admin/failed-tasks/ft1/requeue/', {
      backoff_seconds: 300,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['failed-tasks'] });
  });

  it('drop one posts the note', async () => {
    const { result } = renderHook(() => useDropFailedTask(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'ft1', note: 'duplicate' });
    });
    expect(postMock).toHaveBeenCalledWith('/admin/failed-tasks/ft1/drop/', { note: 'duplicate' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['failed-tasks'] });
  });

  it('requeue-all carries the current filter set as the query string', async () => {
    const { result } = renderHook(() => useRequeueAllFailedTasks(), { wrapper });
    let data: { processed: number; matched: number; capped: boolean } | undefined;
    await act(async () => {
      data = await result.current.mutateAsync({
        filters: {
          status: 'dead',
          task_name: 'sync.push',
          failed_after: '2026-04-01T00:00:00Z',
          failed_before: '2026-04-02T00:00:00Z',
        },
        backoffSeconds: 0,
      });
    });
    expect(postMock).toHaveBeenCalledWith(
      '/admin/failed-tasks/requeue-all/?status=dead&task_name=sync.push&failed_after=2026-04-01T00%3A00%3A00Z&failed_before=2026-04-02T00%3A00%3A00Z',
      { backoff_seconds: 0 },
    );
    expect(data).toEqual({ processed: 3, matched: 5, capped: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['failed-tasks'] });
  });

  it('drop-all omits the query string entirely when no filter is set', async () => {
    const { result } = renderHook(() => useDropAllFailedTasks(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ filters: { status: '' }, note: '' });
    });
    expect(postMock).toHaveBeenCalledWith('/admin/failed-tasks/drop-all/', { note: '' });
  });

  it('offers a bounded, ascending set of backoff choices starting at now', () => {
    expect(BACKOFF_OPTIONS[0]).toEqual({ label: 'Immediately', seconds: 0 });
    const seconds = BACKOFF_OPTIONS.map((o) => o.seconds);
    expect([...seconds].sort((a, b) => a - b)).toEqual(seconds);
  });
});
