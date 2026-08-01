/**
 * Unit tests for resource allocation timeline utilities (issue #85, ADR-0031).
 *
 * Covers:
 *   - detectOverallocatedAssignments: single task, multi-task overlap, exact max_units,
 *     non-overlapping tasks, unscheduled tasks (null dates)
 *   - fitToAllocationWindow: window expansion, alignment to ISO week boundaries
 */

import { describe, it, expect } from 'vitest';
import {
  detectOverallocatedAssignments,
  detectOverallocationWeekRange,
  isoWeekNumber,
  fitToAllocationWindow,
  taskSpanStart,
  parseUTCDate,
  formatISODate,
  isoWeekMonday,
  isoWeekSunday,
} from './resourceUtils';
import type { AllocationTask, AllocationResponse } from './resourceUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `scheduled_start` defaults to `early_start` — the two windows coincide for
 * not-started/complete tasks (ADR-0752 §2), so every pre-existing call below
 * is unaffected. Pass it explicitly to test the in-progress-narrowing case.
 */
function makeTask(
  id: string,
  early_start: string | null,
  early_finish: string | null,
  units: string,
  status: AllocationTask['status'] = 'NOT_STARTED',
  scheduled_start: string | null = early_start,
): AllocationTask {
  return {
    assignment_id: id,
    id,
    name: `Task ${id}`,
    early_start,
    early_finish,
    scheduled_start,
    units,
    status,
  };
}

// ---------------------------------------------------------------------------
// detectOverallocatedAssignments
// ---------------------------------------------------------------------------

describe('detectOverallocatedAssignments', () => {
  it('returns empty set when no tasks', () => {
    expect(detectOverallocatedAssignments([], 1.0).size).toBe(0);
  });

  it('single task within max_units is not flagged', () => {
    const tasks = [makeTask('a1', '2026-03-02', '2026-03-06', '0.50')];
    expect(detectOverallocatedAssignments(tasks, 1.0).size).toBe(0);
  });

  it('single task at exactly max_units is not flagged', () => {
    const tasks = [makeTask('a1', '2026-03-02', '2026-03-06', '1.00')];
    expect(detectOverallocatedAssignments(tasks, 1.0).size).toBe(0);
  });

  it('single task exceeding max_units alone is flagged', () => {
    const tasks = [makeTask('a1', '2026-03-02', '2026-03-06', '1.50')];
    const result = detectOverallocatedAssignments(tasks, 1.0);
    expect(result.has('a1')).toBe(true);
  });

  it('two non-overlapping tasks summing to exactly max_units are not flagged', () => {
    // a1: Mar 2–4 (Mon–Wed), a2: Mar 5–6 (Thu–Fri) — no overlap
    const tasks = [
      makeTask('a1', '2026-03-02', '2026-03-04', '0.50'),
      makeTask('a2', '2026-03-05', '2026-03-06', '0.50'),
    ];
    expect(detectOverallocatedAssignments(tasks, 1.0).size).toBe(0);
  });

  it('two overlapping tasks that together exceed max_units are both flagged', () => {
    // Both cover Mar 2–6 at 0.75 each → sum 1.5 > 1.0
    const tasks = [
      makeTask('a1', '2026-03-02', '2026-03-06', '0.75'),
      makeTask('a2', '2026-03-02', '2026-03-06', '0.75'),
    ];
    const result = detectOverallocatedAssignments(tasks, 1.0);
    expect(result.has('a1')).toBe(true);
    expect(result.has('a2')).toBe(true);
  });

  it('only the overlapping day causes the flag — tasks that only overlap on one day', () => {
    // a1: Mar 2–5, a2: Mar 5–7. Only Mar 5 overlaps.
    const tasks = [
      makeTask('a1', '2026-03-02', '2026-03-05', '0.75'),
      makeTask('a2', '2026-03-05', '2026-03-07', '0.75'),
    ];
    const result = detectOverallocatedAssignments(tasks, 1.0);
    expect(result.has('a1')).toBe(true);
    expect(result.has('a2')).toBe(true);
  });

  it('partial tasks that sum to within max_units are not flagged even if they overlap', () => {
    // 0.3 + 0.4 = 0.7 ≤ 1.0
    const tasks = [
      makeTask('a1', '2026-03-02', '2026-03-06', '0.30'),
      makeTask('a2', '2026-03-02', '2026-03-06', '0.40'),
    ];
    expect(detectOverallocatedAssignments(tasks, 1.0).size).toBe(0);
  });

  it('tasks with null early_start or early_finish are ignored', () => {
    const tasks = [makeTask('a1', null, null, '1.50'), makeTask('a2', '2026-03-02', null, '1.50')];
    // No scheduled spans → nothing to overallocate
    expect(detectOverallocatedAssignments(tasks, 1.0).size).toBe(0);
  });

  it('respects fractional max_units (part-time resource)', () => {
    // Resource at 0.5 max_units; task at 0.6 → overallocated
    const tasks = [makeTask('a1', '2026-03-02', '2026-03-06', '0.60')];
    const result = detectOverallocatedAssignments(tasks, 0.5);
    expect(result.has('a1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fitToAllocationWindow
// ---------------------------------------------------------------------------

describe('fitToAllocationWindow', () => {
  function makeResponse(tasks: Array<{ start: string; finish: string }>): AllocationResponse {
    return {
      project_id: 'proj-1',
      window_start: '2026-03-02',
      window_end: '2026-03-31',
      resources: [
        {
          id: 'r1',
          name: 'Alice',
          email: 'alice@example.com',
          max_units: '1.00',
          tasks: tasks.map((t, i) => makeTask(`a${i}`, t.start, t.finish, '1.00')),
        },
      ],
    };
  }

  it('uses project start date as floor for maxEnd (tasks finishing before project start)', () => {
    const data = makeResponse([{ start: '2026-01-05', finish: '2026-01-10' }]);
    const win = fitToAllocationWindow('2026-03-02', data);
    // minStart = 2026-01-05 (task start < projectStartDate)
    // maxEnd stays at 2026-03-02 (projectStartDate) because 2026-01-10 < 2026-03-02
    expect(win.start).toBe(formatISODate(isoWeekMonday(parseUTCDate('2026-01-05'))));
    expect(win.end).toBe(formatISODate(isoWeekSunday(parseUTCDate('2026-03-02'))));
  });

  it('expands window to cover earliest task start and latest task finish', () => {
    const data = makeResponse([
      { start: '2026-03-10', finish: '2026-03-20' },
      { start: '2026-03-05', finish: '2026-04-15' },
    ]);
    const win = fitToAllocationWindow('2026-03-02', data);
    // earliest start: Mar 5, latest finish: Apr 15
    expect(win.start).toBe(formatISODate(isoWeekMonday(parseUTCDate('2026-03-05'))));
    expect(win.end).toBe(formatISODate(isoWeekSunday(parseUTCDate('2026-04-15'))));
  });

  it('aligns to ISO week boundaries (Monday start, Sunday end)', () => {
    const data = makeResponse([{ start: '2026-03-04', finish: '2026-03-18' }]);
    const win = fitToAllocationWindow('2026-03-02', data);
    // Mar 4 = Wednesday → Monday is Mar 2
    expect(parseUTCDate(win.start).getUTCDay()).toBe(1); // Monday
    // Mar 18 = Wednesday → Sunday is Mar 22
    expect(parseUTCDate(win.end).getUTCDay()).toBe(0); // Sunday
  });

  it('handles empty resources list', () => {
    const data: AllocationResponse = {
      project_id: 'proj-1',
      window_start: '2026-03-02',
      window_end: '2026-03-31',
      resources: [],
    };
    const win = fitToAllocationWindow('2026-03-02', data);
    // minStart = maxEnd = projectStartDate
    expect(win.start).toBe(formatISODate(isoWeekMonday(parseUTCDate('2026-03-02'))));
    expect(win.end).toBe(formatISODate(isoWeekSunday(parseUTCDate('2026-03-02'))));
  });
});

// ---------------------------------------------------------------------------
// isoWeekNumber
// ---------------------------------------------------------------------------

describe('isoWeekNumber', () => {
  it('returns 1 for Jan 4 (always in W1)', () => {
    expect(isoWeekNumber(parseUTCDate('2026-01-04'))).toBe(1);
  });

  it('returns correct week number for a known date', () => {
    // 2026-04-27 (Monday) = W18
    expect(isoWeekNumber(parseUTCDate('2026-04-27'))).toBe(18);
  });

  it('returns same week number for all days in the same ISO week', () => {
    const mon = isoWeekNumber(parseUTCDate('2026-04-27'));
    const sun = isoWeekNumber(parseUTCDate('2026-05-03'));
    expect(mon).toBe(sun);
  });
});

// ---------------------------------------------------------------------------
// detectOverallocationWeekRange
// ---------------------------------------------------------------------------

describe('detectOverallocationWeekRange', () => {
  it('returns null when no tasks', () => {
    expect(detectOverallocationWeekRange([], 1.0)).toBeNull();
  });

  it('returns null when resource is within capacity', () => {
    const tasks = [makeTask('a1', '2026-04-27', '2026-05-03', '0.80')];
    expect(detectOverallocationWeekRange(tasks, 1.0)).toBeNull();
  });

  it('returns single week label when only one week is over-allocated', () => {
    // Two tasks both in W18 (Apr 27–May 3) summing to 1.3 > 1.0
    const tasks = [
      makeTask('a1', '2026-04-27', '2026-05-03', '0.80'),
      makeTask('a2', '2026-04-27', '2026-05-03', '0.50'),
    ];
    const result = detectOverallocationWeekRange(tasks, 1.0);
    expect(result).toBe('W18');
  });

  it('returns a range when multiple consecutive weeks are over-allocated', () => {
    // Task 1 spans W18–W19 at 0.80, Task 2 spans same weeks at 0.50 → both over
    const tasks = [
      makeTask('a1', '2026-04-27', '2026-05-10', '0.80'), // W18–W19
      makeTask('a2', '2026-04-27', '2026-05-10', '0.50'),
    ];
    const result = detectOverallocationWeekRange(tasks, 1.0);
    expect(result).toBe('W18–W19');
  });

  it('ignores unscheduled tasks (null dates)', () => {
    const tasks = [
      makeTask('a1', null, null, '1.50'),
      makeTask('a2', '2026-04-27', '2026-05-03', '0.50'),
    ];
    expect(detectOverallocationWeekRange(tasks, 1.0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #2677 / ADR-0752 — SPAN start (scheduled_start), not the narrowed
// remaining-work window (early_start), drives windowing and rendering.
// ---------------------------------------------------------------------------

describe('taskSpanStart', () => {
  it('prefers scheduled_start over early_start', () => {
    const task = makeTask('a1', '2026-04-08', '2026-04-10', '1.00', 'IN_PROGRESS', '2026-04-01');
    expect(taskSpanStart(task)).toBe('2026-04-01');
  });

  it('falls back to early_start when scheduled_start is null', () => {
    const task = makeTask('a1', '2026-04-01', '2026-04-10', '1.00', 'NOT_STARTED', null);
    expect(taskSpanStart(task)).toBe('2026-04-01');
  });

  it('returns null when both are null (unscheduled)', () => {
    const task = makeTask('a1', null, null, '1.00', 'NOT_STARTED', null);
    expect(taskSpanStart(task)).toBeNull();
  });
});

describe('detectOverallocatedAssignments — SPAN start, not remaining-work window (#2677)', () => {
  it('an in-progress task whose remaining window has narrowed to a single day still counts its full span', () => {
    // Remaining window (early_start) is Apr 6 only; the real span
    // (scheduled_start) is Apr 1–6. Paired with a second task covering the
    // same span, the overlap must be detected across the full span, not just
    // the narrowed single day.
    const tasks = [
      makeTask('a1', '2026-04-06', '2026-04-06', '0.75', 'IN_PROGRESS', '2026-04-01'),
      makeTask('a2', '2026-04-01', '2026-04-06', '0.75'),
    ];
    const result = detectOverallocatedAssignments(tasks, 1.0);
    expect(result.has('a1')).toBe(true);
    expect(result.has('a2')).toBe(true);
  });

  it('pre-fix behavior would have missed the overlap entirely — regression guard', () => {
    // Same inputs as above, but reasoning through what early_start ALONE
    // would have produced: a1's remaining window is a single day (Apr 6)
    // that does not overlap a2's Apr 1-5 portion, so the combined load on
    // Apr 1-5 would never reach a2's own 0.75 (never exceeding 1.0) UNLESS
    // a1's full span is counted on those days too.
    const tasks = [
      makeTask('a2', '2026-04-01', '2026-04-05', '0.75'),
      makeTask('a1', '2026-04-06', '2026-04-06', '0.75', 'IN_PROGRESS', '2026-04-01'),
    ];
    // a1's SPAN (Apr 1-6) overlaps a2 (Apr 1-5) at 0.75 + 0.75 = 1.5 > 1.0
    const result = detectOverallocatedAssignments(tasks, 1.0);
    expect(result.has('a1')).toBe(true);
    expect(result.has('a2')).toBe(true);
  });
});

describe('detectOverallocationWeekRange — SPAN start, not remaining-work window (#2677)', () => {
  it('flags the week the SPAN falls in even when the remaining window has narrowed past it', () => {
    // Remaining window (early_start) is May 3 only (W18); the real span
    // (scheduled_start) starts Apr 27 (also W18) — same week here, so this
    // asserts the span is what's actually walked rather than assuming it.
    const tasks = [
      makeTask('a1', '2026-05-03', '2026-05-03', '0.80', 'IN_PROGRESS', '2026-04-27'),
      makeTask('a2', '2026-04-27', '2026-05-03', '0.50'),
    ];
    expect(detectOverallocationWeekRange(tasks, 1.0)).toBe('W18');
  });
});

describe('fitToAllocationWindow — SPAN start, not remaining-work window (#2677)', () => {
  it('expands to the SPAN start (scheduled_start), not the narrowed early_start', () => {
    // projectStartDate (Mar 15) sits BETWEEN the narrowed early_start (Mar 20)
    // and the real span start (Mar 10), so the two produce different results:
    // early_start alone would never pull minStart earlier than Mar 15.
    const data: AllocationResponse = {
      project_id: 'proj-1',
      window_start: '2026-03-15',
      window_end: '2026-03-31',
      resources: [
        {
          id: 'r1',
          name: 'Alice',
          email: 'alice@example.com',
          max_units: '1.00',
          tasks: [
            // Remaining window (early_start) is Mar 20; real span starts Mar 10.
            makeTask('a1', '2026-03-20', '2026-03-20', '1.00', 'IN_PROGRESS', '2026-03-10'),
          ],
        },
      ],
    };
    const win = fitToAllocationWindow('2026-03-15', data);
    expect(win.start).toBe(formatISODate(isoWeekMonday(parseUTCDate('2026-03-10'))));
  });
});
