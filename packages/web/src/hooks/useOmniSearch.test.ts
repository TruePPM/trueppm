/**
 * Tests for useOmniSearch (ADR-0508 D4, #2103) — the debounced, query-gated ⌘K
 * Epic/Story omni-search hook. Covers the happy path (params + result shape), the
 * inert cases that must never hit the network (disabled, short query), and the
 * shape guard that keeps a malformed body from reaching the palette.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

import { useOmniSearch } from './useOmniSearch';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function envelope(results: unknown) {
  return { data: { count: Array.isArray(results) ? results.length : 0, next: null, previous: null, results } };
}

describe('useOmniSearch', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('debounces, fetches with q + default epic,story type, and returns results', async () => {
    getMock.mockResolvedValueOnce(
      envelope([
        {
          id: 'e1',
          kind: 'task',
          type: 'epic',
          title: 'Login flow',
          program_id: 'p1',
          program_name: 'Q3',
          project_id: 'pr1',
          project_name: 'Web',
          parent_epic_id: null,
          parent_epic_name: null,
        },
      ]),
    );

    const { result } = renderHook(() => useOmniSearch('login'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(result.current.data?.[0].title).toBe('Login flow');
    expect(getMock).toHaveBeenCalledWith('/me/search/', {
      params: { q: 'login', type: 'epic,story' },
    });
  });

  it('is inert when disabled — never hits the network', async () => {
    renderHook(() => useOmniSearch('login', false), { wrapper: makeWrapper(qc) });
    await new Promise((r) => setTimeout(r, 300));
    expect(getMock).not.toHaveBeenCalled();
  });

  it('is inert for a query below the 2-char floor', async () => {
    renderHook(() => useOmniSearch('l'), { wrapper: makeWrapper(qc) });
    await new Promise((r) => setTimeout(r, 300));
    expect(getMock).not.toHaveBeenCalled();
  });

  it('guards a malformed (non-array results) body so the palette never crashes', async () => {
    // The e2e catch-all can return a shape without a proper results array; the hook
    // must coerce to [] rather than hand a non-iterable to the palette.
    getMock.mockResolvedValueOnce({ data: { detail: 'unexpected' } });
    const { result } = renderHook(() => useOmniSearch('login'), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('passes an explicit type override through to the request', async () => {
    getMock.mockResolvedValueOnce(envelope([]));
    renderHook(() => useOmniSearch('login', true, 'epic,story,task'), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/me/search/', {
        params: { q: 'login', type: 'epic,story,task' },
      }),
    );
  });
});
