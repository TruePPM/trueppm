import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { AxiosError } from 'axios';
import {
  useActiveTimer,
  useElapsedSeconds,
  ACTIVE_TIMER_KEY,
  type ActiveTimer,
} from './useActiveTimer';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, delete: deleteMock },
}));

const toastAction = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/components/Toast', () => ({
  toast: { action: toastAction, info: toastInfo, error: toastError },
}));

const RUNNING: ActiveTimer = {
  id: 'timer-1',
  task: 'task-a',
  task_short_id: 'RIV-01',
  task_name: 'Foundation pour',
  project: 'proj-1',
  started_at: '2026-07-05T10:00:00Z',
  elapsed_seconds: 90,
  note: '',
  stale: false,
};

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function conflict(): AxiosError {
  const err = new AxiosError('conflict');
  err.response = { status: 409 } as AxiosError['response'];
  return err;
}

function forbidden(): AxiosError {
  const err = new AxiosError('forbidden');
  err.response = { status: 403 } as AxiosError['response'];
  return err;
}

describe('useActiveTimer', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: { active: false } });
  });

  it('reconciles against the server on mount — {active:false} → no timer', async () => {
    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.timer).toBeNull();
    expect(result.current.isRunning).toBe(false);
    expect(getMock).toHaveBeenCalledWith('/me/timer/');
  });

  it('reconciles an active timer started elsewhere into the running state', async () => {
    getMock.mockResolvedValue({ data: { active: true, ...RUNNING } });
    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isRunning).toBe(true));
    expect(result.current.timer?.task_name).toBe('Foundation pour');
    expect(result.current.isTaskRunning('task-a')).toBe(true);
    expect(result.current.isTaskRunning('task-b')).toBe(false);
  });

  it('starts a timer and writes it into the cache', async () => {
    postMock.mockResolvedValue({ data: { active_timer: RUNNING, finalized_entry: null } });
    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.startTimer('task-a'));
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/me/timer/start', { task: 'task-a' });
    expect(result.current.timer?.task).toBe('task-a');
    expect(toastAction).not.toHaveBeenCalled();
  });

  it('second-start auto-logs the prior timer and shows an Undo toast', async () => {
    // A running timer on task A (the query is the source of truth; agree with it
    // so the queryFn does not overwrite the running state mid-test).
    getMock.mockResolvedValue({ data: { active: true, ...RUNNING } });
    const nextTimer: ActiveTimer = { ...RUNNING, id: 'timer-2', task: 'task-b', task_name: 'Framing' };
    const finalized = {
      id: 'entry-9',
      task: 'task-a',
      minutes: 25,
      entry_date: '2026-07-05',
      note: '',
      source: 'timer',
      server_version: 1,
      created_at: '2026-07-05T10:25:00Z',
    };
    postMock.mockResolvedValue({ data: { active_timer: nextTimer, finalized_entry: finalized } });

    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    act(() => result.current.startTimer('task-b'));
    await waitFor(() => expect(result.current.timer?.task).toBe('task-b'));

    expect(toastAction).toHaveBeenCalledTimes(1);
    expect(toastAction.mock.calls[0][0]).toBe('Logged 25m on RIV-01 · Foundation pour');
    // Undo deletes the finalized entry.
    deleteMock.mockResolvedValue({});
    const action = toastAction.mock.calls[0][1] as { onClick: () => void };
    act(() => action.onClick());
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/me/time-entries/entry-9/'));
  });

  it('stops optimistically, logs the entry, and offers Undo', async () => {
    getMock.mockResolvedValue({ data: { active: true, ...RUNNING } });
    const entry = {
      id: 'entry-1',
      task: 'task-a',
      minutes: 65,
      entry_date: '2026-07-05',
      note: '',
      source: 'timer',
      server_version: 1,
      created_at: '2026-07-05T11:05:00Z',
    };
    let resolvePost: (v: unknown) => void = () => {};
    postMock.mockImplementation(
      () => new Promise((res) => { resolvePost = res; }),
    );

    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    act(() => result.current.stopTimer());
    // Optimistic clear happens before the POST resolves.
    await waitFor(() => expect(result.current.isRunning).toBe(false));

    act(() => resolvePost({ data: entry }));
    await waitFor(() => expect(toastAction).toHaveBeenCalledTimes(1));
    expect(toastAction.mock.calls[0][0]).toBe('Logged 1h 05m on RIV-01 · Foundation pour');
  });

  it('stop invalidates the timesheet and My Work reads so the entry appears (issue 2152)', async () => {
    getMock.mockResolvedValue({ data: { active: true, ...RUNNING } });
    postMock.mockResolvedValue({
      data: {
        id: 'entry-1',
        task: 'task-a',
        minutes: 65,
        entry_date: '2026-07-05',
        note: '',
        source: 'timer',
        server_version: 1,
        created_at: '2026-07-05T11:05:00Z',
      },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    act(() => result.current.stopTimer());
    await waitFor(() => expect(toastAction).toHaveBeenCalledTimes(1));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['timesheet'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'work'] });
  });

  it('second-start (finalized entry) invalidates the entry reads (issue 2152)', async () => {
    getMock.mockResolvedValue({ data: { active: true, ...RUNNING } });
    const nextTimer: ActiveTimer = { ...RUNNING, id: 'timer-2', task: 'task-b', task_name: 'Framing' };
    postMock.mockResolvedValue({
      data: {
        active_timer: nextTimer,
        finalized_entry: {
          id: 'entry-9',
          task: 'task-a',
          minutes: 25,
          entry_date: '2026-07-05',
          note: '',
          source: 'timer',
          server_version: 1,
          created_at: '2026-07-05T10:25:00Z',
        },
      },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    act(() => result.current.startTimer('task-b'));
    await waitFor(() => expect(result.current.timer?.task).toBe('task-b'));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['timesheet'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'work'] });
  });

  it('the timer Undo invalidates the entry reads after removing the entry (issue 2152)', async () => {
    getMock.mockResolvedValue({ data: { active: true, ...RUNNING } });
    postMock.mockResolvedValue({
      data: {
        id: 'entry-1',
        task: 'task-a',
        minutes: 65,
        entry_date: '2026-07-05',
        note: '',
        source: 'timer',
        server_version: 1,
        created_at: '2026-07-05T11:05:00Z',
      },
    });
    deleteMock.mockResolvedValue({});

    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isRunning).toBe(true));
    act(() => result.current.stopTimer());
    await waitFor(() => expect(toastAction).toHaveBeenCalledTimes(1));

    // Spy only on the Undo path so the assertion is unambiguous.
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const action = toastAction.mock.calls[0][1] as { onClick: () => void };
    act(() => action.onClick());
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/me/time-entries/entry-1/'));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['timesheet'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'work'] });
  });

  it('rolls back the optimistic clear if stop fails with a non-409 error', async () => {
    getMock.mockResolvedValue({ data: { active: true, ...RUNNING } });
    postMock.mockRejectedValue(new AxiosError('boom'));

    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    act(() => result.current.stopTimer());
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Rolled back to running.
    expect(result.current.isRunning).toBe(true);
  });

  it('keeps the cleared state (no rollback, no error) when stop returns 409', async () => {
    qc.setQueryData(ACTIVE_TIMER_KEY, RUNNING);
    postMock.mockRejectedValue(conflict());

    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    act(() => result.current.stopTimer());
    await waitFor(() => expect(result.current.isRunning).toBe(false));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('surfaces a permission message when start is forbidden (Viewer)', async () => {
    postMock.mockRejectedValue(forbidden());
    const { result } = renderHook(() => useActiveTimer(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.startTimer('task-a'));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "You don't have permission to log time on this project.",
      ),
    );
    expect(result.current.isRunning).toBe(false);
  });
});

describe('useElapsedSeconds', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns 0 when no timer is running', () => {
    const { result } = renderHook(() => useElapsedSeconds(null));
    expect(result.current).toBe(0);
  });

  it('derives whole seconds from started_at and ticks every second', () => {
    vi.setSystemTime(new Date('2026-07-05T10:01:30Z')); // 90s after start
    const { result } = renderHook(() => useElapsedSeconds('2026-07-05T10:00:00Z'));
    expect(result.current).toBe(90);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(91);
  });

  it('clamps a future started_at (clock skew) to 0', () => {
    vi.setSystemTime(new Date('2026-07-05T10:00:00Z'));
    const { result } = renderHook(() => useElapsedSeconds('2026-07-05T10:05:00Z'));
    expect(result.current).toBe(0);
  });
});
