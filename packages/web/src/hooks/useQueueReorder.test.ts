/**
 * useQueueReorder unit tests (issue 1610).
 *
 * The queue promote/demote POST carries the reordered group in the caller's
 * displayed order, so its three branches each have a UI consequence that must not
 * silently regress:
 *  - the request body shape (id + server_version) the server contract depends on;
 *  - a 409 surfaced as the typed QueueVersionConflictError + an immediate
 *    `['tasks']` invalidate so the UI snaps back to the authoritative server order;
 *  - any other failure rethrown verbatim (no false conflict, no invalidate).
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useQueueReorder,
  QueueVersionConflictError,
  type QueueReorderEntry,
} from './useQueueReorder';

const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const ENTRIES: QueueReorderEntry[] = [
  { id: 't1', serverVersion: 3 },
  { id: 't2', serverVersion: 5 },
];

beforeEach(() => {
  vi.clearAllMocks();
  postMock.mockResolvedValue({ data: {} });
});

describe('useQueueReorder', () => {
  it('sends the {id, server_version} body shape to the queue reorder endpoint', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useQueueReorder('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate(ENTRIES);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/projects/p1/queue/reorder/', {
      tasks: [
        { id: 't1', server_version: 3 },
        { id: 't2', server_version: 5 },
      ],
    });
  });

  it('invalidates the project tasks on success so the new order re-fetches', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useQueueReorder('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate(ENTRIES);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] });
  });

  it('maps a 409 to QueueVersionConflictError and invalidates tasks to snap to server order', async () => {
    postMock.mockRejectedValueOnce({ response: { status: 409 } });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useQueueReorder('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate(ENTRIES);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(QueueVersionConflictError);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] });
  });

  it('rethrows a non-conflict error verbatim and does NOT invalidate', async () => {
    const serverError = { response: { status: 500 } };
    postMock.mockRejectedValueOnce(serverError);
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useQueueReorder('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate(ENTRIES);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).not.toBeInstanceOf(QueueVersionConflictError);
    expect(result.current.error).toBe(serverError);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
