/**
 * Tests for useBoardCardSearch (issue 323, ADR-0145) — the debounced board card
 * search hook. Covers the happy path (matchIds/matchCount) and the inert cases
 * (empty query, no projectId) that must never hit the network.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

import { useBoardCardSearch } from './useBoardCardSearch';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('useBoardCardSearch', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('debounces, fetches, and exposes matching IDs + count', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        { id: 't1', name: 'Foundation pour', status: 'NOT_STARTED', short_id: 'A-1' },
        { id: 't2', name: 'Framing', status: 'IN_PROGRESS', short_id: 'A-2' },
      ],
    });

    const { result } = renderHook(() => useBoardCardSearch('p1', 'found'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.matchCount).toBe(2));
    expect(result.current.matchIds.has('t1')).toBe(true);
    expect(result.current.matchIds.has('t2')).toBe(true);
    expect(result.current.activeQuery).toBe('found');

    // The request carries the project + trimmed query.
    expect(getMock).toHaveBeenCalledWith('/tasks/search/', {
      params: { project: 'p1', q: 'found' },
    });
  });

  it('is inert for an empty / whitespace query — never hits the network', async () => {
    const { result } = renderHook(() => useBoardCardSearch('p1', '   '), {
      wrapper: makeWrapper(qc),
    });
    // Give the debounce window a chance to elapse.
    await new Promise((r) => setTimeout(r, 250));
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.matchIds.size).toBe(0);
    expect(result.current.matchCount).toBe(0);
    expect(result.current.activeQuery).toBe('');
  });

  it('is inert when there is no projectId', async () => {
    const { result } = renderHook(() => useBoardCardSearch(null, 'foundation'), {
      wrapper: makeWrapper(qc),
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.matchIds.size).toBe(0);
  });
});
