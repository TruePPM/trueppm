/**
 * useBacklogItems — the read layer. Covers the list query (both the array and
 * paginated wire shapes the endpoint can return), the snake→camel mapping at
 * the boundary, the `enabled` gate on a missing program id, the single-item
 * derivation off the cached list, and the `patchBacklogCache` / `readBacklogCache`
 * seam every optimistic mutation funnels through.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiBacklogItem } from '../api';
import type { BacklogItem } from '../types';
import {
  backlogKeys,
  patchBacklogCache,
  readBacklogCache,
  useBacklogItem,
  useBacklogItems,
  useMemberProjects,
} from './useBacklogItems';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

const projectsQueryMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useProgramProjects', () => ({ useProgramProjects: projectsQueryMock }));

const PROGRAM = 'p1';

function apiItem(overrides: Partial<ApiBacklogItem> = {}): ApiBacklogItem {
  return {
    id: 'BI-1',
    server_version: 3,
    program: PROGRAM,
    title: 'Telemetry channel',
    description: 'desc',
    item_type: 'story',
    status: 'proposed',
    tags: ['alpha'],
    priority_rank: 2,
    story_points: 5,
    pulled_task: null,
    pulled_at: null,
    pulled_by: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => vi.clearAllMocks());

describe('useBacklogItems query', () => {
  it('fetches a defensively large page and maps the array shape to UI items', async () => {
    getMock.mockResolvedValue({ data: [apiItem(), apiItem({ id: 'BI-2', status: 'pulled' })] });
    const { result } = renderHook(() => useBacklogItems(PROGRAM), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith(`/programs/${PROGRAM}/backlog-items/`, {
      params: { page_size: 200 },
    });
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0]).toMatchObject({
      id: 'BI-1',
      programId: PROGRAM,
      itemType: 'story',
      status: 'PROPOSED',
      priorityRank: 2,
      storyPoints: 5,
    });
    expect(result.current.data![1].status).toBe('PULLED');
  });

  it('unwraps the paginated { results } shape', async () => {
    getMock.mockResolvedValue({ data: { results: [apiItem()] } });
    const { result } = renderHook(() => useBacklogItems(PROGRAM), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('does not fetch when the program id is missing', () => {
    const { result } = renderHook(() => useBacklogItems(undefined), { wrapper: makeWrapper(freshClient()) });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useBacklogItem derivation', () => {
  it('finds a single item in the cached list with no extra request', async () => {
    const qc = freshClient();
    getMock.mockResolvedValue({ data: [apiItem(), apiItem({ id: 'BI-2', title: 'Second' })] });
    const { result } = renderHook(() => useBacklogItem(PROGRAM, 'BI-2'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current?.title).toBe('Second'));
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for a null id', () => {
    getMock.mockResolvedValue({ data: [apiItem()] });
    const { result } = renderHook(() => useBacklogItem(PROGRAM, null), { wrapper: makeWrapper(freshClient()) });
    expect(result.current).toBeUndefined();
  });
});

describe('useMemberProjects', () => {
  it('maps program projects into pull targets', () => {
    projectsQueryMock.mockReturnValue({
      data: [{ id: 'pr-1', name: 'Avionics', colorDot: '#abc' }],
    });
    const { result } = renderHook(() => useMemberProjects(PROGRAM), { wrapper: makeWrapper(freshClient()) });
    expect(result.current.data).toEqual([{ id: 'pr-1', name: 'Avionics', color: '#abc' }]);
  });

  it('returns an empty list while the projects query is loading', () => {
    projectsQueryMock.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useMemberProjects(PROGRAM), { wrapper: makeWrapper(freshClient()) });
    expect(result.current.data).toEqual([]);
  });
});

describe('patchBacklogCache / readBacklogCache', () => {
  const seed: BacklogItem[] = [
    {
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
    },
  ];

  it('reads back what was written and applies the updater in place', () => {
    const qc = freshClient();
    qc.setQueryData(backlogKeys.items(PROGRAM), seed);
    expect(readBacklogCache(qc, PROGRAM)).toEqual(seed);

    patchBacklogCache(qc, PROGRAM, (items) =>
      items.map((i) => ({ ...i, status: 'ARCHIVED' as const })),
    );
    expect(readBacklogCache(qc, PROGRAM)![0].status).toBe('ARCHIVED');
  });

  it('passes an empty list to the updater when the cache is cold', () => {
    const qc = freshClient();
    patchBacklogCache(qc, PROGRAM, (items) => {
      expect(items).toEqual([]);
      return items;
    });
    expect(readBacklogCache(qc, PROGRAM)).toEqual([]);
  });
});
