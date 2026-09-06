import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useMethodologyFlipImpact } from './useMethodologyFlipImpact';

const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

/** The params of the call whose URL matches, or undefined if it never fired. */
function paramsFor(path: string, match: (p: Record<string, unknown>) => boolean) {
  const call = getMock.mock.calls.find(
    (c) =>
      c[0] === path && match((c[1] as { params: Record<string, unknown> } | undefined)?.params ?? {}),
  );
  return (call?.[1] as { params: Record<string, unknown> } | undefined)?.params;
}

describe('useMethodologyFlipImpact', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('reads each count from the paginated envelope, never the row list', async () => {
    getMock.mockImplementation((path: string, cfg: { params: Record<string, unknown> }) => {
      if (path === '/dependencies/') return Promise.resolve({ data: { count: 17, results: [] } });
      if (cfg.params.status === 'BACKLOG')
        return Promise.resolve({ data: { count: 180, results: [] } });
      return Promise.resolve({ data: { count: 64, results: [] } });
    });

    const { result } = renderHook(() => useMethodologyFlipImpact('p-1', true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.backlogCount).toBe(180);
    expect(result.current.taskCount).toBe(64);
    expect(result.current.dependencyCount).toBe(17);
  });

  it('scopes the backlog read to the product-backlog list, and asks for one row', async () => {
    getMock.mockResolvedValue({ data: { count: 0, results: [] } });
    const { result } = renderHook(() => useMethodologyFlipImpact('p-1', true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // `status=BACKLOG AND sprint IS NULL` is the server's own scope for the
    // product-backlog grooming list — the population WATERFALL hides.
    expect(paramsFor('/tasks/', (p) => p.status === 'BACKLOG')).toEqual({
      project: 'p-1',
      status: 'BACKLOG',
      sprint: 'none',
      page_size: 1,
    });
    // Every read is count-only: one row, never a list fetch.
    expect(paramsFor('/tasks/', (p) => p.status === undefined)).toEqual({
      project: 'p-1',
      page_size: 1,
    });
    expect(paramsFor('/dependencies/', () => true)).toEqual({ project: 'p-1', page_size: 1 });
  });

  it('reports a failed read as unknown, not as zero', async () => {
    // The distinction the whole warning rests on (#3313): a failed GET returns
    // no rows, and so does an empty project. Collapsing the two suppresses the
    // one warning the flip has.
    getMock.mockImplementation((_path: string, cfg: { params: Record<string, unknown> }) => {
      if (cfg.params.status === 'BACKLOG') return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: { count: 5, results: [] } });
    });

    const { result } = renderHook(() => useMethodologyFlipImpact('p-1', true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.backlogCount).toBe(null));
    expect(result.current.taskCount).toBe(5);
  });

  it('stays idle while no methodology change is pending', () => {
    // The consolidated settings page mounts every section at once, so an
    // unconditional read would fire three counts on every project settings
    // route. Idle must also read as settled, or it would hold the section's
    // unrelated estimation controls behind a query that never runs.
    getMock.mockResolvedValue({ data: { count: 1, results: [] } });
    const { result } = renderHook(() => useMethodologyFlipImpact('p-1', false), {
      wrapper: wrapper(),
    });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('stays idle with no project id', () => {
    getMock.mockResolvedValue({ data: { count: 1, results: [] } });
    const { result } = renderHook(() => useMethodologyFlipImpact(undefined, true), {
      wrapper: wrapper(),
    });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('defaults a count-less body to 0 rather than NaN', async () => {
    getMock.mockResolvedValue({ data: { results: [] } });
    const { result } = renderHook(() => useMethodologyFlipImpact('p-1', true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.backlogCount).toBe(0);
    expect(result.current.taskCount).toBe(0);
    expect(result.current.dependencyCount).toBe(0);
  });
});
