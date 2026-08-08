import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useUndoPasteManyOperation,
  useUndoCascadeClassificationOperation,
  useUndoImportFixOperation,
  describeUndo,
} from './useBatchOperations';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/api/client', () => ({ apiClient: { post: postMock } }));

function wrapper(queryClient: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Wrapper;
}

describe('ADR-0810 undo hooks', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('useUndoPasteManyOperation POSTs an empty body to the operation route', async () => {
    postMock.mockResolvedValue({ data: { undo: { deleted: 3, kept: 0 } } });
    const { result } = renderHook(() => useUndoPasteManyOperation('proj-1'), {
      wrapper: wrapper(queryClient),
    });
    result.current.mutate('op-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/paste-many-operations/op-1/undo/', {});
    expect(result.current.data?.undo).toEqual({ deleted: 3, kept: 0 });
  });

  it('useUndoPasteManyOperation invalidates the project task list on success', async () => {
    postMock.mockResolvedValue({ data: { undo: { deleted: 1, kept: 0 } } });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUndoPasteManyOperation('proj-1'), {
      wrapper: wrapper(queryClient),
    });
    result.current.mutate('op-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('useUndoCascadeClassificationOperation POSTs to the cascade operation route', async () => {
    postMock.mockResolvedValue({ data: { undo: { reverted: 2, kept: 1 } } });
    const { result } = renderHook(() => useUndoCascadeClassificationOperation('proj-1'), {
      wrapper: wrapper(queryClient),
    });
    result.current.mutate('op-2');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/cascade-classification-operations/op-2/undo/', {});
    expect(result.current.data?.undo).toEqual({ reverted: 2, kept: 1 });
  });

  it('useUndoImportFixOperation POSTs to the project-nested csv import undo route', async () => {
    postMock.mockResolvedValue({ data: { status: 'undone', undo: { deleted: 7, kept: 0 } } });
    const { result } = renderHook(() => useUndoImportFixOperation('proj-1'), {
      wrapper: wrapper(queryClient),
    });
    result.current.mutate('import-req-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/import/csv/import-req-1/undo/', {});
  });

  it('describeUndo reports a clean revert without mentioning kept rows', () => {
    expect(describeUndo({ deleted: 3, kept: 0 })).toBe('Undone — removed 3 rows.');
    expect(describeUndo({ deleted: 1, kept: 0 })).toBe('Undone — removed 1 row.');
  });

  it('describeUndo names how many rows survived because they were touched since', () => {
    expect(describeUndo({ deleted: 2, kept: 1 })).toBe(
      "Undone — removed 2 rows, kept 1 you'd already touched.",
    );
  });

  it('describeUndo uses "reverted" for a classification undo, not "removed"', () => {
    expect(describeUndo({ reverted: 4, kept: 0 })).toBe('Undone — reverted 4 rows.');
  });
});
