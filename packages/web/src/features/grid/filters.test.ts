import { describe, it, expect } from 'vitest';
import { matchesFilters, hasAnyFilter, emptyFilters, isTaskOverdue } from './filters';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'wbs'>): Task {
  return {
    name: overrides.id,
    start: '2026-01-01',
    finish: '2026-01-05',
    duration: 4,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

describe('matchesFilters', () => {
  const task = makeTask({
    id: 't1',
    wbs: '1.1',
    name: 'Design Review',
    status: 'IN_PROGRESS',
    assignees: [{ resourceId: 'r1', name: 'Alice', units: 100 }],
  });

  it('returns true when no filters are set', () => {
    expect(matchesFilters(task, emptyFilters())).toBe(true);
  });

  it('matches search case-insensitively', () => {
    expect(
      matchesFilters(task, {
        search: 'design',
        ownerFilter: '',
        statusFilter: '',
        dueFilter: 'all' as const, labelIds: [],
      }),
    ).toBe(true);
    expect(
      matchesFilters(task, {
        search: 'DESIGN',
        ownerFilter: '',
        statusFilter: '',
        dueFilter: 'all' as const, labelIds: [],
      }),
    ).toBe(true);
    expect(
      matchesFilters(task, {
        search: 'build',
        ownerFilter: '',
        statusFilter: '',
        dueFilter: 'all' as const, labelIds: [],
      }),
    ).toBe(false);
  });

  it('matches owner by exact name', () => {
    expect(
      matchesFilters(task, {
        search: '',
        ownerFilter: 'Alice',
        statusFilter: '',
        dueFilter: 'all' as const, labelIds: [],
      }),
    ).toBe(true);
    expect(
      matchesFilters(task, {
        search: '',
        ownerFilter: 'Bob',
        statusFilter: '',
        dueFilter: 'all' as const, labelIds: [],
      }),
    ).toBe(false);
  });

  it('matches status', () => {
    expect(
      matchesFilters(task, {
        search: '',
        ownerFilter: '',
        statusFilter: 'IN_PROGRESS',
        dueFilter: 'all' as const, labelIds: [],
      }),
    ).toBe(true);
    expect(
      matchesFilters(task, {
        search: '',
        ownerFilter: '',
        statusFilter: 'COMPLETE',
        dueFilter: 'all' as const, labelIds: [],
      }),
    ).toBe(false);
  });

  it('combines all three filters with AND', () => {
    const ok = {
      search: 'design',
      ownerFilter: 'Alice',
      statusFilter: 'IN_PROGRESS' as const,
      dueFilter: 'all' as const, labelIds: [],
    };
    expect(matchesFilters(task, ok)).toBe(true);
    const fail = {
      search: 'design',
      ownerFilter: 'Bob',
      statusFilter: 'IN_PROGRESS' as const,
      dueFilter: 'all' as const, labelIds: [],
    };
    expect(matchesFilters(task, fail)).toBe(false);
  });

  it('treats unassigned tasks as not matching an owner filter', () => {
    const orphan = makeTask({ id: 't2', wbs: '1.2', name: 'Orphan' });
    expect(
      matchesFilters(orphan, {
        search: '',
        ownerFilter: 'Alice',
        statusFilter: '',
        dueFilter: 'all' as const, labelIds: [],
      }),
    ).toBe(false);
  });

  it('overdue filter keeps only late, non-complete tasks', () => {
    const overdue = {
      search: '',
      ownerFilter: '',
      statusFilter: '' as const,
      dueFilter: 'overdue' as const, labelIds: [],
    };
    // task fixture finishes 2026-01-05 with status IN_PROGRESS. Against a
    // "today" far in the future it is overdue; matchesFilters uses the real
    // `new Date()`, which is > 2026, so it is late.
    expect(matchesFilters(task, overdue)).toBe(true);
    const done = makeTask({
      id: 't3',
      wbs: '1.3',
      name: 'Done',
      status: 'COMPLETE',
      finish: '2020-01-01',
    });
    expect(matchesFilters(done, overdue)).toBe(false);
  });
});

describe('isTaskOverdue (parity with server tasks_late_count)', () => {
  // Server definition (projects/views.py): early_finish < today AND status not
  // COMPLETE. Client mirrors it with Task.finish + status.
  const today = new Date(2026, 5, 15); // 2026-06-15 local

  it('is true when finish is before today and not complete', () => {
    expect(isTaskOverdue({ finish: '2026-06-14', status: 'IN_PROGRESS' }, today)).toBe(true);
    expect(isTaskOverdue({ finish: '2026-01-01', status: 'NOT_STARTED' }, today)).toBe(true);
    expect(isTaskOverdue({ finish: '2026-06-14', status: 'BACKLOG' }, today)).toBe(true);
    expect(isTaskOverdue({ finish: '2026-06-14', status: 'REVIEW' }, today)).toBe(true);
    expect(isTaskOverdue({ finish: '2026-06-14', status: 'ON_HOLD' }, today)).toBe(true);
  });

  it('is false for complete tasks even when finish is in the past', () => {
    expect(isTaskOverdue({ finish: '2026-01-01', status: 'COMPLETE' }, today)).toBe(false);
  });

  it('is false when finish is today or in the future (date-only compare)', () => {
    expect(isTaskOverdue({ finish: '2026-06-15', status: 'IN_PROGRESS' }, today)).toBe(false);
    expect(isTaskOverdue({ finish: '2026-06-16', status: 'IN_PROGRESS' }, today)).toBe(false);
  });

  it('is false when finish is missing or unparseable', () => {
    expect(isTaskOverdue({ finish: '', status: 'IN_PROGRESS' }, today)).toBe(false);
    expect(isTaskOverdue({ finish: 'not-a-date', status: 'IN_PROGRESS' }, today)).toBe(false);
  });
});

describe('hasAnyFilter', () => {
  it('returns false for the empty state', () => {
    expect(hasAnyFilter(emptyFilters())).toBe(false);
  });
  it('returns true when search is set', () => {
    expect(
      hasAnyFilter({ search: 'a', ownerFilter: '', statusFilter: '', dueFilter: 'all', labelIds: [] as const }),
    ).toBe(true);
  });
  it('returns true when owner is set', () => {
    expect(
      hasAnyFilter({
        search: '',
        ownerFilter: 'Alice',
        statusFilter: '',
        dueFilter: 'all' as const, labelIds: [],
      }),
    ).toBe(true);
  });
  it('returns true when status is set', () => {
    expect(
      hasAnyFilter({
        search: '',
        ownerFilter: '',
        statusFilter: 'COMPLETE',
        dueFilter: 'all' as const, labelIds: [],
      }),
    ).toBe(true);
  });
});

describe('matchesFilters — label facet (#2383)', () => {
  const labelled = (id: string, ...labelIds: string[]) =>
    makeTask({
      id,
      wbs: `1.${id}`,
      name: id,
      labels: labelIds.map((l) => ({ id: l, name: l, color: 'teal' })),
    });

  const base = { ...emptyFilters() };

  it('an empty label selection is not a filter', () => {
    expect(hasAnyFilter(base)).toBe(false);
    expect(matchesFilters(labelled('a'), base)).toBe(true);
  });

  it('a non-empty selection counts as an active filter', () => {
    expect(hasAnyFilter({ ...base, labelIds: ['l1'] })).toBe(true);
  });

  it('ORs within the facet', () => {
    const filters = { ...base, labelIds: ['l1', 'l2'] };
    expect(matchesFilters(labelled('a', 'l1'), filters)).toBe(true);
    expect(matchesFilters(labelled('b', 'l2'), filters)).toBe(true);
    expect(matchesFilters(labelled('c', 'l3'), filters)).toBe(false);
    expect(matchesFilters(labelled('d'), filters)).toBe(false);
  });

  it('ANDs across facets — a label match still has to clear the other filters', () => {
    const task = makeTask({
      id: 't9',
      wbs: '1.9',
      name: 'Design Review',
      status: 'IN_PROGRESS',
      assignees: [{ resourceId: 'r1', name: 'Alice', units: 100 }],
      labels: [{ id: 'l1', name: 'Needs review', color: 'teal' }],
    });
    expect(matchesFilters(task, { ...base, labelIds: ['l1'] })).toBe(true);
    // Right label, wrong owner → excluded.
    expect(matchesFilters(task, { ...base, labelIds: ['l1'], ownerFilter: 'Bob' })).toBe(false);
    // Right owner, wrong label → excluded.
    expect(matchesFilters(task, { ...base, labelIds: ['other'], ownerFilter: 'Alice' })).toBe(false);
  });
});
