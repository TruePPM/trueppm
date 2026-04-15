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
  fitToAllocationWindow,
  parseUTCDate,
  formatISODate,
  isoWeekMonday,
  isoWeekSunday,
} from './resourceUtils';
import type { AllocationTask, AllocationResponse } from './resourceUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(
  id: string,
  early_start: string | null,
  early_finish: string | null,
  units: string,
  status: AllocationTask['status'] = 'NOT_STARTED',
): AllocationTask {
  return { assignment_id: id, id, name: `Task ${id}`, early_start, early_finish, units, status };
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
    const tasks = [
      makeTask('a1', null, null, '1.50'),
      makeTask('a2', '2026-03-02', null, '1.50'),
    ];
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
