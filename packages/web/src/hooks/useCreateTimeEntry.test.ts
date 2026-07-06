import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { AxiosError } from 'axios';
import { useCreateTimeEntry, type LoggedTimeEntry, type LogTimeVars } from './useCreateTimeEntry';

const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  apiClient: { post: postMock, delete: deleteMock },
}));

const toastAction = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/components/Toast', () => ({
  toast: { action: toastAction, info: toastInfo, error: toastError },
}));

const ENTRY: LoggedTimeEntry = {
  id: 'entry-1',
  task: 'task-a',
  minutes: 90,
  entry_date: '2026-07-06',
  note: '',
  source: 'manual',
  server_version: 1,
  created_at: '2026-07-06T09:00:00Z',
};

const VARS: LogTimeVars = {
  taskId: 'task-a',
  taskLabel: 'RIV-1 · Foundation pour',
  minutes: 90,
  entryDate: '2026-07-06',
  note: 'poured slab',
};

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function withStatus(status: number, data?: unknown): AxiosError {
  const err = new AxiosError('err');
  err.response = { status, data } as AxiosError['response'];
  return err;
}

describe('useCreateTimeEntry', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('POSTs to the nested task time-entries endpoint with the entry body', async () => {
    postMock.mockResolvedValue({ data: ENTRY });
    const { result } = renderHook(() => useCreateTimeEntry(), { wrapper: wrapper(qc) });

    act(() => result.current.mutate(VARS));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/tasks/task-a/time-entries/', {
      minutes: 90,
      entry_date: '2026-07-06',
      note: 'poured slab',
    });
  });

  it('omits an empty note from the request body', async () => {
    postMock.mockResolvedValue({ data: ENTRY });
    const { result } = renderHook(() => useCreateTimeEntry(), { wrapper: wrapper(qc) });

    act(() => result.current.mutate({ ...VARS, note: undefined }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/tasks/task-a/time-entries/', {
      minutes: 90,
      entry_date: '2026-07-06',
    });
  });

  it('raises a success Undo toast and the Undo deletes the entry', async () => {
    postMock.mockResolvedValue({ data: ENTRY });
    deleteMock.mockResolvedValue({ data: {} });
    const { result } = renderHook(() => useCreateTimeEntry(), { wrapper: wrapper(qc) });

    act(() => result.current.mutate(VARS));
    await waitFor(() => expect(toastAction).toHaveBeenCalled());

    const [message, action, opts] = toastAction.mock.calls[0] as [
      string,
      { label: string; ariaLabel?: string; onClick: () => void },
      { variant: string },
    ];
    expect(message).toBe('Logged 1h 30m on RIV-1 · Foundation pour');
    expect(opts).toEqual({ variant: 'success' });

    // Trigger the Undo action → deletes the just-created entry.
    act(() => {
      action.onClick();
    });
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/me/time-entries/entry-1/'));
  });

  it('surfaces a permission-specific message on 403', async () => {
    postMock.mockRejectedValue(withStatus(403));
    const { result } = renderHook(() => useCreateTimeEntry(), { wrapper: wrapper(qc) });

    act(() => result.current.mutate(VARS));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(toastError).toHaveBeenCalledWith(
      "You don't have permission to log time on this project.",
    );
  });

  it('surfaces the server validation reason on 400', async () => {
    postMock.mockRejectedValue(
      withStatus(400, { entry_date: ['Entry date cannot be in the future.'] }),
    );
    const { result } = renderHook(() => useCreateTimeEntry(), { wrapper: wrapper(qc) });

    act(() => result.current.mutate(VARS));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(toastError).toHaveBeenCalledWith('Entry date cannot be in the future.');
  });

  it('falls back to a generic message on an unshaped error', async () => {
    postMock.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useCreateTimeEntry(), { wrapper: wrapper(qc) });

    act(() => result.current.mutate(VARS));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(toastError).toHaveBeenCalledWith('Could not log time. Please try again.');
  });
});
