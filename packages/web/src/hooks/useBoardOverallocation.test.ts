import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBoardOverallocation } from './useBoardOverallocation';

// Stub useResourceAllocation: we want to drive the overallocation calc with
// fixture data and skip the network layer entirely.
vi.mock('./useResourceAllocation', () => ({
  useResourceAllocation: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { useResourceAllocation } from './useResourceAllocation';
const mocked = useResourceAllocation as unknown as ReturnType<typeof vi.fn>;

describe('useBoardOverallocation', () => {
  beforeEach(() => {
    mocked.mockReset();
    localStorage.clear();
  });

  it('returns empty map when no allocation data', () => {
    mocked.mockReturnValue({ data: undefined, status: 'loading', error: null });
    const { result } = renderHook(() => useBoardOverallocation('p1'));
    expect(result.current.overallocByPair.size).toBe(0);
    expect(result.current.scheduleNotRun).toBe(false);
  });

  it('flags scheduleNotRun on 409', () => {
    mocked.mockReturnValue({ data: undefined, status: 'schedule-not-run', error: null });
    const { result } = renderHook(() => useBoardOverallocation('p1'));
    expect(result.current.scheduleNotRun).toBe(true);
  });

  it('flags pair when sum of units exceeds max_units across overlapping window', () => {
    mocked.mockReturnValue({
      data: {
        project_id: 'p1',
        window_start: '2026-04-01',
        window_end: '2026-04-30',
        resources: [
          {
            id: 'r1',
            name: 'Pat',
            email: '',
            max_units: '1.00',
            tasks: [
              {
                assignment_id: 'a1',
                id: 't1',
                name: 'Foundation',
                early_start: '2026-04-01',
                early_finish: '2026-04-05',
                units: '0.60',
                status: 'IN_PROGRESS' as const,
              },
              {
                assignment_id: 'a2',
                id: 't2',
                name: 'Frame',
                early_start: '2026-04-03',
                early_finish: '2026-04-07',
                units: '0.60',
                status: 'IN_PROGRESS' as const,
              },
            ],
          },
        ],
      },
      status: 'success',
      error: null,
    });
    const { result } = renderHook(() => useBoardOverallocation('p1'));
    // Days 04-03 → 04-05 sum to 1.20 (>1.0).  Both tasks touch those days.
    expect(result.current.overallocByPair.get('r1:t1')).toBeCloseTo(1.2, 5);
    expect(result.current.overallocByPair.get('r1:t2')).toBeCloseTo(1.2, 5);
  });

  it('does not flag when sum stays at or below max_units', () => {
    mocked.mockReturnValue({
      data: {
        project_id: 'p1',
        window_start: '2026-04-01',
        window_end: '2026-04-30',
        resources: [
          {
            id: 'r1',
            name: 'Pat',
            email: '',
            max_units: '1.00',
            tasks: [
              {
                assignment_id: 'a1',
                id: 't1',
                name: 'Foundation',
                early_start: '2026-04-01',
                early_finish: '2026-04-05',
                units: '0.50',
                status: 'IN_PROGRESS' as const,
              },
              {
                assignment_id: 'a2',
                id: 't2',
                name: 'Frame',
                early_start: '2026-04-03',
                early_finish: '2026-04-07',
                units: '0.50',
                status: 'IN_PROGRESS' as const,
              },
            ],
          },
        ],
      },
      status: 'success',
      error: null,
    });
    const { result } = renderHook(() => useBoardOverallocation('p1'));
    expect(result.current.overallocByPair.size).toBe(0);
  });

  it('skips tasks with null dates', () => {
    mocked.mockReturnValue({
      data: {
        project_id: 'p1',
        window_start: '2026-04-01',
        window_end: '2026-04-30',
        resources: [
          {
            id: 'r1',
            name: 'Pat',
            email: '',
            max_units: '1.00',
            tasks: [
              {
                assignment_id: 'a1',
                id: 't1',
                name: 'Unscheduled',
                early_start: null,
                early_finish: null,
                units: '2.00',
                status: 'NOT_STARTED' as const,
              },
            ],
          },
        ],
      },
      status: 'success',
      error: null,
    });
    const { result } = renderHook(() => useBoardOverallocation('p1'));
    expect(result.current.overallocByPair.size).toBe(0);
  });

  it('respects localStorage threshold override', () => {
    localStorage.setItem('board:overallocThreshold', '1.5');
    mocked.mockReturnValue({
      data: {
        project_id: 'p1',
        window_start: '2026-04-01',
        window_end: '2026-04-30',
        resources: [
          {
            id: 'r1',
            name: 'Pat',
            email: '',
            max_units: '1.00',
            tasks: [
              {
                assignment_id: 'a1',
                id: 't1',
                name: 'Solo',
                early_start: '2026-04-01',
                early_finish: '2026-04-05',
                units: '1.20',
                status: 'IN_PROGRESS' as const,
              },
            ],
          },
        ],
      },
      status: 'success',
      error: null,
    });
    const { result } = renderHook(() => useBoardOverallocation('p1'));
    // 1.2 > 1.0 default but ≤ 1.5 override threshold → not flagged.
    expect(result.current.overallocByPair.size).toBe(0);
  });
});
