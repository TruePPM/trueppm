import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ApiSprint } from '@/types';
import type { SprintBurnSnapshot } from '@/hooks/useSprints';
import {
  deriveSprintSeries,
  idealSlopeDenominator,
  idealRemainingAt,
} from './BurnChart';

// ---------------------------------------------------------------------------
// Unit tests for the sprint burndown series math (issue 1249).
//
// The bug: the compact sparkline drew the solid "actual remaining" line on a
// different coordinate system than the dashed "ideal" line — the ideal trend
// number used a different denominator than the plotted ideal slope, and the
// actual line back-filled future/un-snapshotted days with the committed value,
// so it flat-lined at the top while ideal declined to zero. The two lines
// therefore never met at the sprint-end / zero corner.
//
// The contract these tests pin:
//   1. ideal at day 0   == committed
//   2. ideal at day N    == 0  (the final grid row)
//   3. both lines share ONE x grid (one point per inclusive day) and the same
//      y anchors (committed top, zero baseline)
//   4. the actual line stops at the last real snapshot rather than riding flat
//      to the sprint-end corner (future grid rows are null)
//   5. the trend number uses the SAME slope denominator as the plotted ideal
// ---------------------------------------------------------------------------

function makeSprint(overrides: Partial<ApiSprint> = {}): ApiSprint {
  return {
    id: 'sp-1',
    server_version: 1,
    short_id: 'A1',
    short_id_display: 'SP-A1',
    name: 'Sprint 1',
    goal: null,
    notes: '',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
    state: 'ACTIVE',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: null,
    wip_limit: null,
    committed_points: 40,
    committed_task_count: 8,
    completed_points: null,
    completed_task_count: null,
    completion_ratio_points: null,
    completion_ratio_tasks: null,
    activated_at: '2026-04-01T00:00:00Z',
    closed_at: null,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  } as ApiSprint;
}

function snap(overrides: Partial<SprintBurnSnapshot>): SprintBurnSnapshot {
  return {
    id: `sn-${overrides.snapshot_date ?? '?'}`,
    snapshot_date: '2026-04-01',
    remaining_points: 40,
    remaining_task_count: 8,
    completed_points: 0,
    completed_task_count: 0,
    scope_change_points: 0,
    scope_change_task_count: 0,
    created_at: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('idealSlopeDenominator', () => {
  it('returns the number of grid STEPS (inclusive days - 1)', () => {
    // 2026-04-01 .. 2026-04-14 inclusive = 14 rows, 13 steps
    expect(idealSlopeDenominator('2026-04-01', '2026-04-14')).toBe(13);
  });

  it('floors at 1 for a single-day sprint (no divide-by-zero)', () => {
    expect(idealSlopeDenominator('2026-04-01', '2026-04-01')).toBe(1);
  });
});

describe('idealRemainingAt', () => {
  it('equals committed at day 0', () => {
    expect(idealRemainingAt(40, 0, 13)).toBe(40);
  });

  it('equals 0 at the final grid row', () => {
    expect(idealRemainingAt(40, 13, 13)).toBe(0);
  });

  it('is the midpoint halfway through', () => {
    expect(idealRemainingAt(40, 6.5, 13)).toBeCloseTo(20, 6);
  });
});

describe('deriveSprintSeries — ideal line anchors (issue 1249)', () => {
  it('ideal at day 0 == committed and at day N == 0', () => {
    const { points } = deriveSprintSeries(makeSprint(), [], 'points');
    expect(points).toHaveLength(14); // inclusive days
    expect(points[0].ideal).toBe(40);
    expect(points[points.length - 1].ideal).toBe(0);
  });

  it('produces a single point per inclusive day (shared x grid)', () => {
    const { points } = deriveSprintSeries(makeSprint(), [], 'tasks');
    const dates = points.map((p) => p.date);
    expect(dates[0]).toBe('2026-04-01');
    expect(dates[dates.length - 1]).toBe('2026-04-14');
    // strictly increasing, no gaps
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i] > dates[i - 1]).toBe(true);
    }
  });

  it('ideal declines monotonically from committed to zero', () => {
    const { points } = deriveSprintSeries(makeSprint(), [], 'points');
    for (let i = 1; i < points.length; i++) {
      expect(points[i].ideal).toBeLessThan(points[i - 1].ideal);
    }
  });
});

describe('deriveSprintSeries — actual line shares the ideal coordinate system', () => {
  it('day 0 actual remaining == committed == ideal (lines coincide at start)', () => {
    const { points } = deriveSprintSeries(makeSprint(), [], 'points');
    expect(points[0].remaining).toBe(40);
    expect(points[0].ideal).toBe(40);
  });

  it('does NOT back-fill future days with the committed value — they are null', () => {
    // One snapshot on day 7; days after it have no data and must be null so the
    // actual line ENDS rather than flat-lining to the sprint-end corner.
    const snapshots = [snap({ snapshot_date: '2026-04-07', remaining_points: 18 })];
    const { points } = deriveSprintSeries(makeSprint(), snapshots, 'points');
    const day7 = points.find((p) => p.date === '2026-04-07');
    const lastRow = points[points.length - 1];
    expect(day7?.remaining).toBe(18);
    // last grid row (2026-04-14) is past the last snapshot → null, NOT 40
    expect(lastRow.date).toBe('2026-04-14');
    expect(lastRow.remaining).toBeNull();
  });

  it('the latest actual node maps to the elapsed snapshot day, not the sprint end', () => {
    const snapshots = [snap({ snapshot_date: '2026-04-07', remaining_points: 18 })];
    const { points } = deriveSprintSeries(makeSprint(), snapshots, 'points');
    // The last non-null remaining is the day-7 snapshot value.
    const lastReal = [...points].reverse().find((p) => p.remaining !== null);
    expect(lastReal?.date).toBe('2026-04-07');
    expect(lastReal?.remaining).toBe(18);
  });

  it('carries the last known remaining forward across a gap BEFORE the last snapshot', () => {
    const snapshots = [
      snap({ snapshot_date: '2026-04-03', remaining_points: 30 }),
      snap({ snapshot_date: '2026-04-07', remaining_points: 18 }),
    ];
    const { points } = deriveSprintSeries(makeSprint(), snapshots, 'points');
    // 2026-04-05 has no snapshot but sits between two snapshots → carry 30 fwd.
    expect(points.find((p) => p.date === '2026-04-05')?.remaining).toBe(30);
    // 2026-04-10 is past the last snapshot → null.
    expect(points.find((p) => p.date === '2026-04-10')?.remaining).toBeNull();
  });
});

describe('deriveSprintSeries — trend uses the same slope denominator (issue 1249)', () => {
  const RealDate = Date;

  afterEach(() => {
    vi.useRealTimers();
    globalThis.Date = RealDate;
  });

  it('trendAhead compares actual vs ideal at the SAME grid row', () => {
    // Freeze "now" to day 7 of the sprint (2026-04-07, the 7th row, 0-based 6).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-07T12:00:00Z'));

    const committed = 40;
    const snapshots = [snap({ snapshot_date: '2026-04-07', remaining_points: 18 })];
    const { trendAhead } = deriveSprintSeries(makeSprint(), snapshots, 'points');

    // Plotted ideal at row 6 with denom 13: 40 * (1 - 6/13) = 21.538...
    const denom = idealSlopeDenominator('2026-04-01', '2026-04-14');
    const expectedIdeal = idealRemainingAt(committed, 6, denom);
    // trendAhead = ideal - actual = 21.538 - 18 ≈ 3.538 (ahead)
    expect(trendAhead).not.toBeNull();
    expect(trendAhead as number).toBeCloseTo(expectedIdeal - 18, 6);
    expect(trendAhead as number).toBeGreaterThan(0); // ahead of ideal
  });
});

describe('deriveSprintSeries — single-day sprint edge case', () => {
  it('does not divide by zero and anchors ideal at committed for the lone day', () => {
    const sprint = makeSprint({ start_date: '2026-04-01', finish_date: '2026-04-01' });
    const { points } = deriveSprintSeries(sprint, [], 'points');
    expect(points).toHaveLength(1);
    expect(points[0].ideal).toBe(40);
    expect(points[0].remaining).toBe(40);
  });
});
