import { describe, it, expect } from 'vitest';
import type { Task } from '@/types';
import { isMissingCommittedStart } from './missingCommittedStart';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '2026-01-13',
    finish: '2026-01-28',
    duration: 12,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    readiness: 'ready',
    assignees: [],
    notes: '',
    totalFloat: 3,
    ...overrides,
  };
}

describe('isMissingCommittedStart (#317 / ADR-0603)', () => {
  it('fires for IN_PROGRESS / REVIEW / COMPLETE with no committed plannedStart', () => {
    for (const status of ['IN_PROGRESS', 'REVIEW', 'COMPLETE'] as const) {
      expect(isMissingCommittedStart(makeTask({ status, plannedStart: null }))).toBe(true);
    }
  });

  it('does not fire before the task is in progress', () => {
    for (const status of ['BACKLOG', 'NOT_STARTED'] as const) {
      expect(isMissingCommittedStart(makeTask({ status, plannedStart: null }))).toBe(false);
    }
  });

  it('does not fire once a start is committed (plannedStart set)', () => {
    expect(
      isMissingCommittedStart(makeTask({ status: 'IN_PROGRESS', plannedStart: '2026-01-13' })),
    ).toBe(false);
  });

  it('ignores the CPM-computed start (task.start is always filled)', () => {
    // A committed-less in-progress task still has a computed start — the flag
    // must key off plannedStart, not start, or it would never fire.
    expect(
      isMissingCommittedStart(makeTask({ status: 'IN_PROGRESS', start: '2026-01-13', plannedStart: null })),
    ).toBe(true);
  });

  it('excludes summary tasks (dates roll up from children, not a committed start)', () => {
    expect(
      isMissingCommittedStart(makeTask({ status: 'IN_PROGRESS', isSummary: true, plannedStart: null })),
    ).toBe(false);
  });
});
