import { describe, it, expect } from 'vitest';
import type { Task } from '@/types';
import { isMissingCommittedStart, isStartComputed } from './missingCommittedStart';

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

describe('isStartComputed (#3063)', () => {
  it('fires for every status once plannedStart is absent — including NOT_STARTED', () => {
    // The regression this file exists to prevent. NOT_STARTED is the status that
    // fills the Unscheduled gutter, so it is the one case that MUST carry the
    // computed cue; gating the cue on isMissingCommittedStart excluded exactly it.
    for (const status of ['BACKLOG', 'NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'COMPLETE'] as const) {
      expect(isStartComputed(makeTask({ status, plannedStart: null }))).toBe(true);
    }
  });

  it('stops firing once the PM commits a start', () => {
    for (const status of ['NOT_STARTED', 'IN_PROGRESS'] as const) {
      expect(isStartComputed(makeTask({ status, plannedStart: '2026-01-13' }))).toBe(false);
    }
  });

  it('does not fire when CPM has produced no start to qualify', () => {
    expect(isStartComputed(makeTask({ status: 'NOT_STARTED', start: '', plannedStart: null }))).toBe(
      false,
    );
  });

  it('excludes summary tasks, matching the gutter and the renderer', () => {
    expect(
      isStartComputed(makeTask({ status: 'NOT_STARTED', isSummary: true, plannedStart: null })),
    ).toBe(false);
  });

  it('is strictly wider than isMissingCommittedStart — every flagged task is also computed', () => {
    // The two predicates must never disagree in the direction that would let a
    // flagged task render a plain, committed-looking date.
    for (const status of ['BACKLOG', 'NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'COMPLETE'] as const) {
      for (const plannedStart of [null, '2026-01-13']) {
        for (const isSummary of [false, true]) {
          const task = makeTask({ status, plannedStart, isSummary });
          if (isMissingCommittedStart(task)) expect(isStartComputed(task)).toBe(true);
        }
      }
    }
  });
});
