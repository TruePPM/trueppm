import { describe, it, expect } from 'vitest';
import { matchesFilters, hasAnyFilter, emptyFilters } from './filters';
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
    id: 't1', wbs: '1.1', name: 'Design Review',
    status: 'IN_PROGRESS',
    assignees: [{ resourceId: 'r1', name: 'Alice', units: 100 }],
  });

  it('returns true when no filters are set', () => {
    expect(matchesFilters(task, emptyFilters())).toBe(true);
  });

  it('matches search case-insensitively', () => {
    expect(matchesFilters(task, { search: 'design', ownerFilter: '', statusFilter: '' })).toBe(true);
    expect(matchesFilters(task, { search: 'DESIGN', ownerFilter: '', statusFilter: '' })).toBe(true);
    expect(matchesFilters(task, { search: 'build', ownerFilter: '', statusFilter: '' })).toBe(false);
  });

  it('matches owner by exact name', () => {
    expect(matchesFilters(task, { search: '', ownerFilter: 'Alice', statusFilter: '' })).toBe(true);
    expect(matchesFilters(task, { search: '', ownerFilter: 'Bob', statusFilter: '' })).toBe(false);
  });

  it('matches status', () => {
    expect(matchesFilters(task, { search: '', ownerFilter: '', statusFilter: 'IN_PROGRESS' })).toBe(true);
    expect(matchesFilters(task, { search: '', ownerFilter: '', statusFilter: 'COMPLETE' })).toBe(false);
  });

  it('combines all three filters with AND', () => {
    const ok = { search: 'design', ownerFilter: 'Alice', statusFilter: 'IN_PROGRESS' as const };
    expect(matchesFilters(task, ok)).toBe(true);
    const fail = { search: 'design', ownerFilter: 'Bob', statusFilter: 'IN_PROGRESS' as const };
    expect(matchesFilters(task, fail)).toBe(false);
  });

  it('treats unassigned tasks as not matching an owner filter', () => {
    const orphan = makeTask({ id: 't2', wbs: '1.2', name: 'Orphan' });
    expect(matchesFilters(orphan, { search: '', ownerFilter: 'Alice', statusFilter: '' })).toBe(false);
  });
});

describe('hasAnyFilter', () => {
  it('returns false for the empty state', () => {
    expect(hasAnyFilter(emptyFilters())).toBe(false);
  });
  it('returns true when search is set', () => {
    expect(hasAnyFilter({ search: 'a', ownerFilter: '', statusFilter: '' })).toBe(true);
  });
  it('returns true when owner is set', () => {
    expect(hasAnyFilter({ search: '', ownerFilter: 'Alice', statusFilter: '' })).toBe(true);
  });
  it('returns true when status is set', () => {
    expect(hasAnyFilter({ search: '', ownerFilter: '', statusFilter: 'COMPLETE' })).toBe(true);
  });
});
