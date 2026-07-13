/**
 * Round-trip coverage for BoardSavedView config (issue #1918).
 *
 * The board filter-bar facets (assignee/priority/due-window; issue 1091) are
 * persisted into `config.filter_*` alongside the six pre-existing keys. These
 * tests exercise the wire-format translation in isolation from the board UI:
 * `useBoardSavedViews` maps camelCase `FacetFilters` <-> snake_case
 * `filter_*` keys on create/read, and defaults an absent/legacy payload to
 * "no filters active" rather than throwing or dropping the field.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useBoardSavedViews, type BoardViewConfig } from './useBoardSavedViews';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock, patch: vi.fn(), delete: vi.fn() } }));

const BASE_API_CONFIG = {
  sort: 'priority' as const,
  show_wip: true,
  show_col_tints: true,
  evm_mode: 'off' as const,
  show_cost: false,
  risk_linked_only: false,
};

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useBoardSavedViews — filter facet round trip (#1918)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('reads active filter_* keys off the wire into a camelCase FacetFilters', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        {
          id: 'sv-1',
          name: 'Alice High',
          config: {
            ...BASE_API_CONFIG,
            filter_assignees: ['r1', '__unassigned__'],
            filter_priority: ['high'],
            filter_due: ['overdue'],
          },
          schema_version: 2,
          created_by: 'user-1',
          server_version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const { result } = renderHook(() => useBoardSavedViews('proj-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0].config.filters).toEqual({
      assignees: ['r1', '__unassigned__'],
      priority: ['high'],
      due: ['overdue'],
    });
  });

  it('defaults filters to empty when a stored (legacy v1) payload has no filter_* keys', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        {
          id: 'sv-legacy',
          name: 'Pre-#1918 view',
          config: { ...BASE_API_CONFIG }, // no filter_* keys at all
          schema_version: 1,
          created_by: null,
          server_version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const { result } = renderHook(() => useBoardSavedViews('proj-1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.views[0].config.filters).toEqual({ assignees: [], priority: [], due: [] });
  });

  it('POSTs the active facets as filter_* keys when creating a view', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        id: 'sv-new',
        name: 'New',
        config: {
          ...BASE_API_CONFIG,
          filter_assignees: ['r2'],
          filter_priority: [],
          filter_due: ['this_week'],
        },
        schema_version: 2,
        created_by: 'user-1',
        server_version: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    });

    const { result } = renderHook(() => useBoardSavedViews('proj-1'), { wrapper: makeWrapper(qc) });

    const config: BoardViewConfig = {
      sort: 'priority',
      showWip: true,
      showColTints: true,
      evmMode: 'off',
      showCost: false,
      riskLinkedOnly: false,
      filters: { assignees: ['r2'], priority: [], due: ['this_week'] },
    };
    result.current.create.mutate({ name: 'New', config });

    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/board-views/', {
      name: 'New',
      config: {
        ...BASE_API_CONFIG,
        filter_assignees: ['r2'],
        filter_priority: [],
        filter_due: ['this_week'],
      },
    });
  });

  it('POSTs an explicit empty filter_* set when config.filters is omitted', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        id: 'sv-new',
        name: 'No filters',
        config: { ...BASE_API_CONFIG, filter_assignees: [], filter_priority: [], filter_due: [] },
        schema_version: 2,
        created_by: 'user-1',
        server_version: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    });

    const { result } = renderHook(() => useBoardSavedViews('proj-1'), { wrapper: makeWrapper(qc) });

    const config: BoardViewConfig = {
      sort: 'priority',
      showWip: true,
      showColTints: true,
      evmMode: 'off',
      showCost: false,
      riskLinkedOnly: false,
      // filters intentionally omitted
    };
    result.current.create.mutate({ name: 'No filters', config });

    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/board-views/', {
      name: 'No filters',
      config: { ...BASE_API_CONFIG, filter_assignees: [], filter_priority: [], filter_due: [] },
    });
  });
});
