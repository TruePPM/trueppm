import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import {
  UNASSIGNED,
  EMPTY_FACETS,
  priorityBandOf,
  dueWindowsOf,
  matchesFacets,
  activeFacetCount,
  isFacetsActive,
  collectAssigneeOptions,
  parseFacetsFromParams,
  writeFacetsToParams,
  paramsHaveFacets,
  serializeFacets,
  deserializeFacets,
  toggleFacetValue,
  type FacetFilters,
} from './boardFacets';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '2026-04-01',
    finish: '2026-04-10',
    duration: 1,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    plannedStart: '2026-04-01',
    notes: '',
    ...overrides,
  };
}

const NOW = new Date('2026-04-08T12:00:00Z'); // a Wednesday

describe('priorityBandOf', () => {
  it('buckets integer ranks into High/Medium/Low', () => {
    expect(priorityBandOf(1)).toBe('high');
    expect(priorityBandOf(3)).toBe('high');
    expect(priorityBandOf(4)).toBe('medium');
    expect(priorityBandOf(7)).toBe('medium');
    expect(priorityBandOf(8)).toBe('low');
    expect(priorityBandOf(99)).toBe('low');
  });

  it('maps a missing rank to Unranked', () => {
    expect(priorityBandOf(undefined)).toBe('unranked');
    expect(priorityBandOf(null)).toBe('unranked');
  });
});

describe('dueWindowsOf', () => {
  it('flags a task whose finish is before today as overdue', () => {
    const t = makeTask({ finish: '2026-04-01', plannedStart: '2026-03-30' });
    expect([...dueWindowsOf(t, NOW)]).toEqual(['overdue']);
  });

  it('flags a task due later this week (through Sunday) as this_week', () => {
    // Wed 2026-04-08 → end of week is Sun 2026-04-12.
    expect(dueWindowsOf(makeTask({ finish: '2026-04-08' }), NOW).has('this_week')).toBe(true);
    expect(dueWindowsOf(makeTask({ finish: '2026-04-12' }), NOW).has('this_week')).toBe(true);
  });

  it('does not flag a task due next week', () => {
    const t = makeTask({ finish: '2026-04-13' }); // Monday, next week
    expect(dueWindowsOf(t, NOW).size).toBe(0);
  });

  it('EDGE: an unscheduled task (plannedStart null, early start set) is never in a due window even when overdue', () => {
    // start (early_start) is populated by CPM, but plannedStart is null and the
    // task is in no sprint — it is not committed, so no due window applies.
    const t = makeTask({
      plannedStart: null,
      sprintId: null,
      start: '2026-03-01',
      finish: '2026-03-15', // would be "overdue" if it counted
    });
    expect(dueWindowsOf(t, NOW).size).toBe(0);
  });

  it('a sprint-committed task with plannedStart null still counts (sprint = commitment)', () => {
    const t = makeTask({ plannedStart: null, sprintId: 's1', finish: '2026-04-01' });
    expect(dueWindowsOf(t, NOW).has('overdue')).toBe(true);
  });
});

describe('matchesFacets', () => {
  it('no active facets → everything matches', () => {
    expect(matchesFacets(makeTask(), EMPTY_FACETS, NOW)).toBe(true);
  });

  it('assignee facet matches a selected resource', () => {
    const t = makeTask({ assignees: [{ resourceId: 'r1', name: 'Priya', units: 1 }] });
    expect(matchesFacets(t, { ...EMPTY_FACETS, assignees: ['r1'] }, NOW)).toBe(true);
    expect(matchesFacets(t, { ...EMPTY_FACETS, assignees: ['r2'] }, NOW)).toBe(false);
  });

  it('EDGE: Unassigned option matches only cards with no assignees', () => {
    const unassigned = makeTask({ id: 'u', assignees: [] });
    const assigned = makeTask({ id: 'a', assignees: [{ resourceId: 'r1', name: 'Priya', units: 1 }] });
    const filters: FacetFilters = { ...EMPTY_FACETS, assignees: [UNASSIGNED] };
    expect(matchesFacets(unassigned, filters, NOW)).toBe(true);
    expect(matchesFacets(assigned, filters, NOW)).toBe(false);
  });

  it('Unassigned OR a named resource (OR within the assignee group)', () => {
    const filters: FacetFilters = { ...EMPTY_FACETS, assignees: [UNASSIGNED, 'r1'] };
    expect(matchesFacets(makeTask({ assignees: [] }), filters, NOW)).toBe(true);
    expect(
      matchesFacets(makeTask({ assignees: [{ resourceId: 'r1', name: 'Priya', units: 1 }] }), filters, NOW),
    ).toBe(true);
    expect(
      matchesFacets(makeTask({ assignees: [{ resourceId: 'r9', name: 'X', units: 1 }] }), filters, NOW),
    ).toBe(false);
  });

  it('priority band facet matches derived band', () => {
    expect(matchesFacets(makeTask({ priorityRank: 2 }), { ...EMPTY_FACETS, priority: ['high'] }, NOW)).toBe(true);
    expect(matchesFacets(makeTask({ priorityRank: 5 }), { ...EMPTY_FACETS, priority: ['high'] }, NOW)).toBe(false);
    expect(matchesFacets(makeTask({ priorityRank: undefined }), { ...EMPTY_FACETS, priority: ['unranked'] }, NOW)).toBe(true);
  });

  it('due facet matches overdue tasks', () => {
    const overdue = makeTask({ finish: '2026-04-01', plannedStart: '2026-03-30' });
    expect(matchesFacets(overdue, { ...EMPTY_FACETS, due: ['overdue'] }, NOW)).toBe(true);
    expect(matchesFacets(makeTask({ finish: '2026-05-01' }), { ...EMPTY_FACETS, due: ['overdue'] }, NOW)).toBe(false);
  });

  it('AND across groups: must match every active group', () => {
    const t = makeTask({
      assignees: [{ resourceId: 'r1', name: 'Priya', units: 1 }],
      priorityRank: 2,
      finish: '2026-04-01',
      plannedStart: '2026-03-30',
    });
    // matches assignee + priority + due
    expect(matchesFacets(t, { assignees: ['r1'], priority: ['high'], due: ['overdue'] }, NOW)).toBe(true);
    // right assignee + priority but wrong due window → excluded
    expect(matchesFacets(t, { assignees: ['r1'], priority: ['high'], due: ['this_week'] }, NOW)).toBe(false);
  });
});

describe('activeFacetCount / isFacetsActive', () => {
  it('counts every selected value across groups', () => {
    expect(activeFacetCount(EMPTY_FACETS)).toBe(0);
    expect(isFacetsActive(EMPTY_FACETS)).toBe(false);
    const f: FacetFilters = { assignees: ['r1', UNASSIGNED], priority: ['high'], due: [] };
    expect(activeFacetCount(f)).toBe(3);
    expect(isFacetsActive(f)).toBe(true);
  });
});

describe('collectAssigneeOptions', () => {
  it('returns unique assignees sorted by name', () => {
    const tasks = [
      makeTask({ assignees: [{ resourceId: 'r2', name: 'Sam', units: 1 }] }),
      makeTask({ assignees: [{ resourceId: 'r1', name: 'Alex', units: 1 }] }),
      makeTask({ assignees: [{ resourceId: 'r1', name: 'Alex', units: 1 }] }), // dup
      makeTask({ assignees: [] }),
    ];
    expect(collectAssigneeOptions(tasks)).toEqual([
      { resourceId: 'r1', name: 'Alex' },
      { resourceId: 'r2', name: 'Sam' },
    ]);
  });
});

describe('URL param round-trip', () => {
  it('parses and writes facet params', () => {
    const filters: FacetFilters = { assignees: ['r1', UNASSIGNED], priority: ['high', 'low'], due: ['overdue'] };
    const params = new URLSearchParams();
    writeFacetsToParams(params, filters);
    expect(params.get('fa')).toBe(`r1,${UNASSIGNED}`);
    expect(params.get('fp')).toBe('high,low');
    expect(params.get('fd')).toBe('overdue');
    expect(parseFacetsFromParams(params)).toEqual(filters);
  });

  it('drops invalid priority/due tokens on parse', () => {
    const params = new URLSearchParams('fp=high,bogus&fd=whenever,overdue');
    expect(parseFacetsFromParams(params)).toEqual({ assignees: [], priority: ['high'], due: ['overdue'] });
  });

  it('writing empty groups deletes the keys', () => {
    const params = new URLSearchParams('fa=r1&fp=high&fd=overdue');
    writeFacetsToParams(params, EMPTY_FACETS);
    expect(paramsHaveFacets(params)).toBe(false);
  });

  it('paramsHaveFacets detects any facet key', () => {
    expect(paramsHaveFacets(new URLSearchParams('sprint=s1'))).toBe(false);
    expect(paramsHaveFacets(new URLSearchParams('fp=high'))).toBe(true);
  });
});

describe('localStorage serialization', () => {
  it('round-trips and drops invalid tokens', () => {
    const filters: FacetFilters = { assignees: ['r1'], priority: ['medium'], due: ['this_week'] };
    expect(deserializeFacets(serializeFacets(filters))).toEqual(filters);
    expect(deserializeFacets(null)).toEqual(EMPTY_FACETS);
    expect(deserializeFacets('{ not json')).toEqual(EMPTY_FACETS);
    expect(deserializeFacets('{"priority":["nope","low"]}')).toEqual({
      assignees: [],
      priority: ['low'],
      due: [],
    });
  });
});

describe('toggleFacetValue', () => {
  it('adds then removes a value immutably', () => {
    const a = toggleFacetValue(EMPTY_FACETS, 'priority', 'high');
    expect(a.priority).toEqual(['high']);
    const b = toggleFacetValue(a, 'priority', 'high');
    expect(b.priority).toEqual([]);
    expect(EMPTY_FACETS.priority).toEqual([]); // original untouched
  });
});
