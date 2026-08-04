import { describe, it, expect } from 'vitest';
import type { ProjectResource, Task } from '@/types';
import { findUnresolvedOwnerRow } from './unresolvedOwnerNav';

function member(id: string, name: string): ProjectResource {
  return {
    id: `pr-${id}`,
    projectId: 'p1',
    resourceId: id,
    resource: {
      id,
      name,
      email: `${id}@example.com`,
      jobRole: '',
      maxUnits: 1,
      calendarId: null,
      skills: [],
    },
    roleTitle: '',
    unitsOverride: null,
    effectiveMaxUnits: 1,
    notes: '',
  } as ProjectResource;
}

const ANA = member('r-ana', 'Ana Rivera');
const POOL = [ANA];

function task(id: string, name: string): Task {
  return {
    id,
    wbs: '1',
    name,
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
  };
}

// t1 resolved, t2 unresolved, t3 resolved, t4 unresolved, t5 resolved
const TASKS: Task[] = [
  task('t1', 'Plan @ana'),
  task('t2', 'Build @nobody'),
  task('t3', 'Ship it'),
  task('t4', 'Review @ghost'),
  task('t5', 'Done'),
];

describe('findUnresolvedOwnerRow (#2727, ADR-0776 §3 — F8/Shift+F8)', () => {
  it('forward from no current row starts at the first row', () => {
    expect(findUnresolvedOwnerRow(TASKS, POOL, null, 'forward')?.id).toBe('t2');
  });

  it('backward from no current row starts at the last row', () => {
    expect(findUnresolvedOwnerRow(TASKS, POOL, null, 'backward')?.id).toBe('t4');
  });

  it('forward finds the next unresolved row after the current one', () => {
    expect(findUnresolvedOwnerRow(TASKS, POOL, 't2', 'forward')?.id).toBe('t4');
  });

  it('backward finds the previous unresolved row before the current one', () => {
    expect(findUnresolvedOwnerRow(TASKS, POOL, 't4', 'backward')?.id).toBe('t2');
  });

  it('forward wraps around past the end of the list', () => {
    expect(findUnresolvedOwnerRow(TASKS, POOL, 't4', 'forward')?.id).toBe('t2');
  });

  it('backward wraps around past the start of the list', () => {
    expect(findUnresolvedOwnerRow(TASKS, POOL, 't2', 'backward')?.id).toBe('t4');
  });

  it('returns null when no row has an unresolved token', () => {
    const allResolved = [task('a', 'Plan @ana'), task('b', 'Ship it')];
    expect(findUnresolvedOwnerRow(allResolved, POOL, null, 'forward')).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(findUnresolvedOwnerRow([], POOL, null, 'forward')).toBeNull();
  });

  it('a lone unresolved row is found even starting from itself (wraps back to itself)', () => {
    const solo = [task('a', 'Plan @ana'), task('b', 'Build @nobody'), task('c', 'Ship it')];
    expect(findUnresolvedOwnerRow(solo, POOL, 'b', 'forward')?.id).toBe('b');
    expect(findUnresolvedOwnerRow(solo, POOL, 'b', 'backward')?.id).toBe('b');
  });

  it('treats an unrecognized currentId the same as no current row (forward)', () => {
    expect(findUnresolvedOwnerRow(TASKS, POOL, 'not-visible', 'forward')?.id).toBe('t2');
  });
});
