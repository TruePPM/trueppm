/**
 * usePullItem — the optimistic pull, its rollback, and undo. These are the
 * paths a fixture/manual click rarely exercises but a failure absolutely will,
 * so they're the priority for unit coverage. `onMutate` is async (it cancels
 * in-flight queries first), so the optimistic flip is awaited, not synchronous.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem, MemberProject } from '../types';
import { backlogKeys } from './useBacklogItems';
import { usePullItem, type UsePullItemOptions } from './usePullItem';

const PROGRAM = 'p1';

const ITEM: BacklogItem = {
  id: 'BI-001',
  programId: PROGRAM,
  title: 'Telemetry channel B',
  itemType: 'story',
  status: 'PROPOSED',
  tags: [],
  priorityRank: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const PROJECT: MemberProject = {
  id: 'p-3',
  name: 'Avionics',
  code: 'ARTM-3',
  color: '#000',
  backlogCount: 9,
};

function setup(options: UsePullItemOptions = {}, initialItems: BacklogItem[] = [ITEM]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(backlogKeys.items(PROGRAM), initialItems);
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  const { result } = renderHook(() => usePullItem(PROGRAM, options), { wrapper: Wrapper });
  const read = () => qc.getQueryData<BacklogItem[]>(backlogKeys.items(PROGRAM))!;
  return { result, read };
}

describe('usePullItem', () => {
  it('optimistically flips the item to PULLED and fills the task id on success', async () => {
    const { result, read } = setup({ pullFn: () => Promise.resolve({ taskId: 't-99' }) });

    act(() => {
      result.current.pull({ item: ITEM, project: PROJECT });
    });

    await waitFor(() => expect(read()[0].status).toBe('PULLED'));
    expect(read()[0].pulledTo?.projectName).toBe('Avionics');
    await waitFor(() => expect(read()[0].pulledTo?.taskId).toBe('t-99'));
  });

  it('rolls back to the pre-pull snapshot when the API rejects', async () => {
    const onError = vi.fn();
    const { result, read } = setup({ pullFn: () => Promise.reject(new Error('boom')) });

    act(() => {
      result.current.pull({ item: ITEM, project: PROJECT }, { onError });
    });

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(read()[0].status).toBe('PROPOSED');
    expect(read()[0].pulledTo).toBeUndefined();
  });

  it('undo reverts a pulled item and calls the reverse endpoint', async () => {
    const undoFn = vi.fn().mockResolvedValue(undefined);
    const pulled: BacklogItem = {
      ...ITEM,
      status: 'PULLED',
      pulledTo: {
        projectId: 'p-3',
        projectName: 'Avionics',
        taskId: 't-1',
        at: '2026-01-02T00:00:00Z',
      },
    };
    const { result, read } = setup({ undoFn }, [pulled]);

    await act(async () => {
      await result.current.undo(pulled);
    });

    expect(read()[0].status).toBe('PROPOSED');
    expect(read()[0].pulledTo).toBeUndefined();
    expect(undoFn).toHaveBeenCalledWith({ item: pulled });
  });
});
