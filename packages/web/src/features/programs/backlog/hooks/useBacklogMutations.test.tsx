/**
 * useBacklogMutations — the write layer. Each mutation must hit the right
 * endpoint with the right (snake_case) payload AND reconcile the cached list so
 * the UI updates without a refetch. The reconciliation is the regression-prone
 * half: create upserts, patch replaces in place, delete filters out, and
 * archive/restore/reorder are all PATCH shortcuts. All covered against a seeded
 * QueryClient with the apiClient mocked.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiBacklogItem } from '../api';
import type { BacklogItem } from '../types';
import { backlogKeys } from './useBacklogItems';
import { useBacklogMutations } from './useBacklogMutations';

const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  apiClient: { post: postMock, patch: patchMock, delete: deleteMock },
}));

const PROGRAM = 'p1';
const BASE = `/programs/${PROGRAM}/backlog-items/`;

function apiItem(overrides: Partial<ApiBacklogItem> = {}): ApiBacklogItem {
  return {
    id: 'BI-1',
    server_version: 1,
    program: PROGRAM,
    title: 'One',
    description: '',
    item_type: 'story',
    status: 'proposed',
    tags: [],
    priority_rank: 1,
    story_points: null,
    pulled_task: null,
    pulled_at: null,
    pulled_by: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function existing(): BacklogItem {
  return {
    id: 'BI-1',
    programId: PROGRAM,
    title: 'One',
    itemType: 'story',
    status: 'PROPOSED',
    tags: [],
    priorityRank: 1,
    serverVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function setup(seed: BacklogItem[] = []) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(backlogKeys.items(PROGRAM), seed);
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  const { result } = renderHook(() => useBacklogMutations(PROGRAM), { wrapper: Wrapper });
  const read = () => qc.getQueryData<BacklogItem[]>(backlogKeys.items(PROGRAM))!;
  return { result, read };
}

afterEach(() => vi.clearAllMocks());

describe('useBacklogMutations', () => {
  it('createItem trims, posts the API shape, and appends to the cache', async () => {
    postMock.mockResolvedValue({ data: apiItem({ id: 'BI-2', title: 'New', description: 'body' }) });
    const { result, read } = setup([existing()]);

    await act(async () => {
      await result.current.createItem({
        title: '  New  ',
        itemType: 'bug',
        description: '  body  ',
        tags: ['x'],
      });
    });

    expect(postMock).toHaveBeenCalledWith(BASE, {
      title: 'New',
      item_type: 'bug',
      description: 'body',
      tags: ['x'],
    });
    expect(read().map((i) => i.id)).toEqual(['BI-1', 'BI-2']);
  });

  it('updateItem PATCHes the changed fields and replaces the cached row in place', async () => {
    patchMock.mockResolvedValue({ data: apiItem({ title: 'Renamed' }) });
    const { result, read } = setup([existing()]);

    await act(async () => {
      await result.current.updateItem('BI-1', { title: 'Renamed' });
    });

    expect(patchMock).toHaveBeenCalledWith(`${BASE}BI-1/`, { title: 'Renamed' });
    expect(read()).toHaveLength(1);
    expect(read()[0].title).toBe('Renamed');
  });

  it('archiveItem and restoreItem PATCH the status enum', async () => {
    patchMock.mockResolvedValue({ data: apiItem({ status: 'archived' }) });
    const { result } = setup([existing()]);
    await act(async () => {
      await result.current.archiveItem('BI-1');
    });
    expect(patchMock).toHaveBeenCalledWith(`${BASE}BI-1/`, { status: 'archived' });

    patchMock.mockResolvedValue({ data: apiItem({ status: 'proposed' }) });
    await act(async () => {
      await result.current.restoreItem('BI-1');
    });
    expect(patchMock).toHaveBeenLastCalledWith(`${BASE}BI-1/`, { status: 'proposed' });
  });

  it('reorderItem PATCHes priority_rank', async () => {
    patchMock.mockResolvedValue({ data: apiItem({ priority_rank: 9 }) });
    const { result, read } = setup([existing()]);
    await act(async () => {
      await result.current.reorderItem('BI-1', 9);
    });
    expect(patchMock).toHaveBeenCalledWith(`${BASE}BI-1/`, { priority_rank: 9 });
    expect(read()[0].priorityRank).toBe(9);
  });

  it('deleteItem DELETEs and removes the row from the cache', async () => {
    deleteMock.mockResolvedValue({});
    const { result, read } = setup([existing(), { ...existing(), id: 'BI-2', title: 'Two' }]);
    await act(async () => {
      await result.current.deleteItem('BI-1');
    });
    expect(deleteMock).toHaveBeenCalledWith(`${BASE}BI-1/`);
    expect(read().map((i) => i.id)).toEqual(['BI-2']);
  });

  it('exposes a combined isPending flag', async () => {
    let resolvePost!: (value: { data: ApiBacklogItem }) => void;
    postMock.mockReturnValue(
      new Promise<{ data: ApiBacklogItem }>((resolve) => {
        resolvePost = resolve;
      }),
    );
    const { result } = setup();
    act(() => {
      void result.current.createItem({ title: 'x', itemType: 'story', tags: [] });
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));

    await act(async () => {
      resolvePost({ data: apiItem({ id: 'BI-9' }) });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });
});
