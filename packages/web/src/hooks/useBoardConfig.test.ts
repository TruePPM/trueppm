import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { COLUMN_SLA_DEFAULTS, useBoardConfig, type BoardColumnDef } from './useBoardConfig';

const getMock = vi.hoisted(() => vi.fn());
const putMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock, put: putMock } }));

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  getMock.mockReset();
  putMock.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

const API_COLUMNS = {
  columns: [
    // Saved override wins over the per-status default; lanes translate to camelCase.
    {
      status: 'IN_PROGRESS',
      label: 'Doing',
      visible: true,
      wip_limit: 4,
      color: '#3B82F6',
      age_threshold_days: 3,
      lanes: [
        { key: 'expedite', label: 'Expedite', wip_limit: 1, current_count: 2, breach: 'over' },
      ],
    },
    // Legacy payload: no age_threshold_days, no lanes → default SLA, empty lanes.
    { status: 'REVIEW', label: 'Review', visible: true, wip_limit: null, color: null },
    // Explicit null override → default SLA; a status with no default → slaDays undefined.
    {
      status: 'COMPLETE',
      label: 'Done',
      visible: false,
      wip_limit: null,
      color: null,
      age_threshold_days: null,
      lanes: [],
    },
  ],
};

describe('useBoardConfig', () => {
  it('serves the five-column default while disabled or before the read lands', () => {
    const { result } = renderHook(() => useBoardConfig(null), { wrapper });
    expect(result.current.columns.map((c) => c.status)).toEqual([
      'BACKLOG',
      'NOT_STARTED',
      'IN_PROGRESS',
      'REVIEW',
      'COMPLETE',
    ]);
    expect(result.current.columns[2].wipLimit).toBe(5);
    expect(result.current.isLoading).toBe(false);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('translates the wire format to camelCase and derives the effective SLA', async () => {
    getMock.mockResolvedValue({ data: API_COLUMNS });
    const { result } = renderHook(() => useBoardConfig('p1'), { wrapper });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/board-config/');

    const [doing, review, done] = result.current.columns;
    expect(doing).toEqual({
      status: 'IN_PROGRESS',
      label: 'Doing',
      visible: true,
      wipLimit: 4,
      color: '#3B82F6',
      ageThresholdDays: 3,
      slaDays: 3,
      lanes: [{ key: 'expedite', label: 'Expedite', wipLimit: 1, currentCount: 2, breach: 'over' }],
    });
    expect(review.ageThresholdDays).toBeNull();
    expect(review.slaDays).toBe(COLUMN_SLA_DEFAULTS.REVIEW);
    expect(review.lanes).toEqual([]);
    expect(done.slaDays).toBeUndefined();
    expect(done.visible).toBe(false);
  });

  it('saves in snake_case without echoing server-derived lane fields, then seeds the cache', async () => {
    getMock.mockResolvedValue({ data: API_COLUMNS });
    const { result } = renderHook(() => useBoardConfig('p1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const edited: BoardColumnDef[] = [
      {
        status: 'IN_PROGRESS',
        label: 'Doing',
        visible: true,
        wipLimit: 6,
        color: '#3B82F6',
        ageThresholdDays: null,
        slaDays: 10,
        lanes: [
          { key: 'expedite', label: 'Expedite', wipLimit: 2, currentCount: 2, breach: 'over' },
        ],
      },
      {
        status: 'REVIEW',
        label: 'Review',
        visible: true,
        wipLimit: null,
        color: null,
        ageThresholdDays: 2,
      },
    ];
    putMock.mockResolvedValue({
      data: {
        columns: [
          {
            status: 'IN_PROGRESS',
            label: 'Doing',
            visible: true,
            wip_limit: 6,
            color: '#3B82F6',
            age_threshold_days: null,
            lanes: [],
          },
        ],
      },
    });
    await act(async () => {
      await result.current.save(edited);
    });
    expect(putMock).toHaveBeenCalledWith('/projects/p1/board-config/', {
      columns: [
        {
          status: 'IN_PROGRESS',
          label: 'Doing',
          visible: true,
          wip_limit: 6,
          color: '#3B82F6',
          age_threshold_days: null,
          lanes: [{ key: 'expedite', label: 'Expedite', wip_limit: 2 }],
        },
        {
          status: 'REVIEW',
          label: 'Review',
          visible: true,
          wip_limit: null,
          color: null,
          age_threshold_days: 2,
          lanes: [],
        },
      ],
    });
    // The PUT response replaces the cached read — no second GET.
    await waitFor(() => expect(result.current.columns).toHaveLength(1));
    expect(result.current.columns[0].wipLimit).toBe(6);
    expect(result.current.columns[0].slaDays).toBe(COLUMN_SLA_DEFAULTS.IN_PROGRESS);
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
