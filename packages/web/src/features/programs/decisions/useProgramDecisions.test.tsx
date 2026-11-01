/**
 * Server-state hooks for the program decision log (#4772).
 *
 * Pins the cache contract the page relies on: one query per status under the
 * `['program-decisions', programId, status]` key, the status sent as a filter,
 * and every write invalidating the program's whole prefix (a status change
 * moves a row between the two lists).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProgramDecisions, useSaveProgramDecision } from './useProgramDecisions';

const { mockedGet, mockedPost, mockedPatch } = vi.hoisted(() => ({
  mockedGet: vi.fn(),
  mockedPost: vi.fn(),
  mockedPatch: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: mockedGet, post: mockedPost, patch: mockedPatch },
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

beforeEach(() => {
  mockedGet.mockReset();
  mockedPost.mockReset();
  mockedPatch.mockReset();
});

describe('useProgramDecisions', () => {
  it('reads one status, page 1, under a per-status key', async () => {
    mockedGet.mockResolvedValue({
      data: { count: 3, next: 'http://x/?page=2', previous: null, results: [{ id: 'a' }] },
    });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useProgramDecisions('p1', 'made'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockedGet).toHaveBeenCalledWith('/programs/p1/decisions/', {
      params: { status: 'made', page: 1 },
    });
    expect(result.current.total).toBe(3);
    expect(result.current.decisions).toEqual([{ id: 'a' }]);
    expect(result.current.hasNextPage).toBe(true);
    expect(client.getQueryData(['program-decisions', 'p1', 'made'])).toBeDefined();
    expect(client.getQueryData(['program-decisions', 'p1', 'awaiting'])).toBeUndefined();
  });

  it('asks for the next page when there is one', async () => {
    mockedGet
      .mockResolvedValueOnce({
        data: { count: 2, next: 'http://x/?page=2', previous: null, results: [{ id: 'a' }] },
      })
      .mockResolvedValueOnce({
        data: { count: 2, next: null, previous: 'http://x/', results: [{ id: 'b' }] },
      });
    const { wrapper } = setup();
    const { result } = renderHook(() => useProgramDecisions('p1', 'awaiting'), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(mockedGet).toHaveBeenLastCalledWith('/programs/p1/decisions/', {
      params: { status: 'awaiting', page: 2 },
    });
    await waitFor(() => expect(result.current.decisions.map((d) => d.id)).toEqual(['a', 'b']));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('does not fetch without a program id', () => {
    const { wrapper } = setup();
    renderHook(() => useProgramDecisions(undefined, 'awaiting'), { wrapper });
    expect(mockedGet).not.toHaveBeenCalled();
  });
});

describe('useSaveProgramDecision', () => {
  it('POSTs a new decision and invalidates the program prefix', async () => {
    mockedPost.mockResolvedValue({ data: { id: 'n' } });
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSaveProgramDecision('p1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ body: { title: 'x' } });
    });
    expect(mockedPost).toHaveBeenCalledWith('/programs/p1/decisions/', { title: 'x' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['program-decisions', 'p1'] });
  });

  it('PATCHes an existing decision by id and invalidates the same prefix', async () => {
    mockedPatch.mockResolvedValue({ data: { id: 'd1' } });
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSaveProgramDecision('p1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'd1', body: { status: 'made' } });
    });
    expect(mockedPatch).toHaveBeenCalledWith('/programs/p1/decisions/d1/', { status: 'made' });
    expect(mockedPost).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['program-decisions', 'p1'] });
  });
});
