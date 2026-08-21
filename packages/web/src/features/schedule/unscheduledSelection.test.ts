/**
 * Pure helpers behind the gutter → outline selection bridge (#2987).
 *
 * The two failure modes these pin are both silent: offering to schedule a row
 * whose dates the tray does not own, and selecting a row that is not in
 * `visibleTasks` and therefore never reaches the batch.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '@/types';
import { datableUnscheduledIds, ancestorIdsOf } from './unscheduledSelection';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    wbs: '1',
    name: 'Task',
    start: '',
    finish: '',
    duration: 1,
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
  } as Task;
}

describe('datableUnscheduledIds', () => {
  it('offers To Do and Backlog rows the tray renders as draggable', () => {
    const ids = datableUnscheduledIds([
      makeTask({ id: 'a', status: 'NOT_STARTED' }),
      makeTask({ id: 'b', status: 'BACKLOG' }),
    ]);
    expect(ids).toEqual(['a', 'b']);
  });

  it('excludes sprint-targeted rows — their dates come from sprint planning', () => {
    const ids = datableUnscheduledIds([
      makeTask({ id: 'a', status: 'NOT_STARTED' }),
      makeTask({ id: 'b', status: 'BACKLOG', sprintId: 's1' }),
    ]);
    expect(ids).toEqual(['a']);
  });

  it('returns an empty list when every row is sprint-targeted', () => {
    const ids = datableUnscheduledIds([
      makeTask({ id: 'a', status: 'BACKLOG', sprintId: 's1' }),
      makeTask({ id: 'b', status: 'BACKLOG', sprintId: 's2' }),
    ]);
    expect(ids).toEqual([]);
  });
});

describe('ancestorIdsOf', () => {
  const tree = [
    makeTask({ id: 'root', parentId: null }),
    makeTask({ id: 'phase', parentId: 'root' }),
    makeTask({ id: 'leaf', parentId: 'phase' }),
    makeTask({ id: 'other', parentId: null }),
  ];

  it('walks parentId to the root so a collapsed phase is expanded', () => {
    expect(ancestorIdsOf(tree, ['leaf']).sort()).toEqual(['phase', 'root']);
  });

  it('returns nothing for a root-level row', () => {
    expect(ancestorIdsOf(tree, ['other'])).toEqual([]);
  });

  it('de-duplicates a shared ancestor across several targets', () => {
    const sibling = makeTask({ id: 'leaf2', parentId: 'phase' });
    expect(ancestorIdsOf([...tree, sibling], ['leaf', 'leaf2']).sort()).toEqual(['phase', 'root']);
  });

  it('terminates on a self-parent rather than spinning', () => {
    const cyclic = [makeTask({ id: 'x', parentId: 'x' })];
    expect(ancestorIdsOf(cyclic, ['x'])).toEqual([]);
  });

  it('terminates on a parent loop, and never lists the target as its own ancestor', () => {
    const cyclic = [
      makeTask({ id: 'a', parentId: 'b' }),
      makeTask({ id: 'b', parentId: 'a' }),
    ];
    // Walks a → b, then sees 'a' already visited and stops. 'a' is the target,
    // so it must not appear in its own ancestor set even though the loop
    // reaches it.
    expect(ancestorIdsOf(cyclic, ['a'])).toEqual(['b']);
  });

  it('stops at a parent id that is not in the task list', () => {
    const orphan = [makeTask({ id: 'kid', parentId: 'missing' })];
    expect(ancestorIdsOf(orphan, ['kid'])).toEqual(['missing']);
  });
});
