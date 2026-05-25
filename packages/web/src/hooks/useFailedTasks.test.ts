/**
 * Unit tests for useFailedTasks / useFailedTask — verifies query-key factory
 * and API call shapes.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useFailedTasks,
  useFailedTask,
  failedTasksKeys,
  type FailedTaskFilters,
} from './useFailedTasks';

const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const sampleTask = {
  id: 'abc123',
  task_name: 'trueppm.drain_outbox',
  task_id: 'cel-uuid-1234',
  args: [],
  kwargs: {},
  exception_type: 'RuntimeError',
  exception_message: 'Connection refused',
  traceback: 'Traceback (most recent call last):\n  ...',
  failure_count: 3,
  first_failed_at: '2026-05-24T10:00:00Z',
  last_failed_at: '2026-05-25T08:00:00Z',
  status: 'dead' as const,
};

const paginatedResponse = {
  count: 1,
  next: null,
  previous: null,
  results: [sampleTask],
};

// ---------------------------------------------------------------------------
// failedTasksKeys
// ---------------------------------------------------------------------------

describe('failedTasksKeys', () => {
  it('has a stable "all" key', () => {
    expect(failedTasksKeys.all).toEqual(['failed-tasks']);
  });

  it('list() embeds the filter object in the key', () => {
    const filters: FailedTaskFilters = { status: 'dead' };
    const key = failedTasksKeys.list(filters);
    expect(key[0]).toBe('failed-tasks');
    expect(key[1]).toBe('list');
    expect(key[2]).toEqual(filters);
  });

  it('detail() embeds the id in the key', () => {
    const key = failedTasksKeys.detail('abc123');
    expect(key[0]).toBe('failed-tasks');
    expect(key[1]).toBe('detail');
    expect(key[2]).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// useFailedTasks
// ---------------------------------------------------------------------------

describe('useFailedTasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls GET /admin/failed-tasks/ with no params when filters are empty', async () => {
    getMock.mockResolvedValue({ data: paginatedResponse });
    const qc = newQc();
    const { result } = renderHook(
      () => useFailedTasks({}),
      { wrapper: makeWrapper(qc) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/admin/failed-tasks/', { params: {} });
    expect(result.current.data?.results).toHaveLength(1);
  });

  it('passes status and task_name params when set', async () => {
    getMock.mockResolvedValue({ data: paginatedResponse });
    const qc = newQc();
    const filters: FailedTaskFilters = { status: 'dead', task_name: 'drain' };
    renderHook(() => useFailedTasks(filters), { wrapper: makeWrapper(qc) });
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/admin/failed-tasks/', {
        params: { status: 'dead', task_name: 'drain' },
      }),
    );
  });

  it('passes failed_after param when time window is set', async () => {
    getMock.mockResolvedValue({ data: paginatedResponse });
    const qc = newQc();
    const filters: FailedTaskFilters = { failed_after: '2026-05-24T00:00:00.000Z' };
    renderHook(() => useFailedTasks(filters), { wrapper: makeWrapper(qc) });
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/admin/failed-tasks/', {
        params: { failed_after: '2026-05-24T00:00:00.000Z' },
      }),
    );
  });

  it('surfaces an error when the API call fails', async () => {
    getMock.mockRejectedValue(new Error('403 Forbidden'));
    const qc = newQc();
    const { result } = renderHook(() => useFailedTasks({}), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// useFailedTask (detail)
// ---------------------------------------------------------------------------

describe('useFailedTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not fetch when id is null', () => {
    getMock.mockResolvedValue({ data: sampleTask });
    const qc = newQc();
    renderHook(() => useFailedTask(null), { wrapper: makeWrapper(qc) });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('does not fetch when id is empty string', () => {
    getMock.mockResolvedValue({ data: sampleTask });
    const qc = newQc();
    renderHook(() => useFailedTask(''), { wrapper: makeWrapper(qc) });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('fetches GET /admin/failed-tasks/{id}/ when id is non-null', async () => {
    getMock.mockResolvedValue({ data: sampleTask });
    const qc = newQc();
    const { result } = renderHook(() => useFailedTask('abc123'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/admin/failed-tasks/abc123/');
    expect(result.current.data?.task_name).toBe('trueppm.drain_outbox');
  });
});
