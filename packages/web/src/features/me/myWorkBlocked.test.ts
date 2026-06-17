import { describe, expect, it } from 'vitest';

import type { MyWorkTask } from '@/hooks/useMyWork';
import { countBlocked, selectVisibleTasks } from './myWorkBlocked';

function task(id: string, is_blocked: boolean): MyWorkTask {
  return {
    id,
    short_id: id,
    name: `Task ${id}`,
    project_id: 'p1',
    project_name: 'Proj',
    sprint_id: null,
    sprint_name: null,
    status: 'IN_PROGRESS',
    story_points: null,
    remaining_points: null,
    due: null,
    due_source: null,
    is_critical: false,
    group: 'today',
    is_blocked,
    blocked_reason: '',
    blocker_type: '',
    blocked_age_seconds: null,
    server_version: 1,
    url: `/t/${id}`,
  };
}

describe('myWorkBlocked selectors (#1198)', () => {
  const tasks = [task('a', false), task('b', true), task('c', false), task('d', true)];

  it('countBlocked counts only flagged-blocked tasks', () => {
    expect(countBlocked(tasks)).toBe(2);
    expect(countBlocked([])).toBe(0);
    expect(countBlocked([task('x', false)])).toBe(0);
  });

  it('selectVisibleTasks narrows to blocked when blockedOnly is on', () => {
    const blocked = selectVisibleTasks(tasks, true);
    expect(blocked.map((t) => t.id)).toEqual(['b', 'd']);
  });

  it('selectVisibleTasks passes the full list through when blockedOnly is off', () => {
    expect(selectVisibleTasks(tasks, false)).toBe(tasks);
  });
});
