import { describe, it, expect } from 'vitest';
import { buildSubgraph } from './buildSubgraph';
import type { Task, TaskLink } from '@/types';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    wbs: id,
    name: id,
    start: '2025-01-06',
    finish: '2025-01-10',
    duration: 5,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    ...overrides,
  };
}

function link(id: string, sourceId: string, targetId: string, type: TaskLink['type'] = 'FS'): TaskLink {
  return { id, sourceId, targetId, type, lag: 0, isCritical: false };
}

describe('buildSubgraph', () => {
  it('returns only the start task when it has no successors', () => {
    const tasks = [task('A'), task('B')];
    const { tasks: subTasks, edges } = buildSubgraph('A', tasks, []);
    expect(subTasks).toHaveLength(1);
    expect(subTasks[0].id).toBe('A');
    expect(edges).toHaveLength(0);
  });

  it('includes direct successors', () => {
    const tasks = [task('A'), task('B'), task('C')];
    const links = [link('l1', 'A', 'B')];
    const { tasks: subTasks } = buildSubgraph('A', tasks, links);
    const ids = subTasks.map((t) => t.id).sort();
    expect(ids).toEqual(['A', 'B']);
  });

  it('includes transitive successors', () => {
    const tasks = [task('A'), task('B'), task('C'), task('D')];
    const links = [link('l1', 'A', 'B'), link('l2', 'B', 'C'), link('l3', 'C', 'D')];
    const { tasks: subTasks } = buildSubgraph('A', tasks, links);
    expect(subTasks).toHaveLength(4);
  });

  it('excludes tasks upstream of start', () => {
    const tasks = [task('Upstream'), task('A'), task('B')];
    const links = [link('l1', 'Upstream', 'A'), link('l2', 'A', 'B')];
    const { tasks: subTasks } = buildSubgraph('A', tasks, links);
    const ids = subTasks.map((t) => t.id);
    expect(ids).not.toContain('Upstream');
    expect(ids).toContain('A');
    expect(ids).toContain('B');
  });

  it('includes only edges internal to the subgraph', () => {
    const tasks = [task('Upstream'), task('A'), task('B')];
    const links = [link('l1', 'Upstream', 'A'), link('l2', 'A', 'B')];
    const { edges } = buildSubgraph('A', tasks, links);
    // l1 has Upstream (not in subgraph) → excluded; l2 is internal → included
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe('A');
    expect(edges[0].targetId).toBe('B');
  });

  it('maps CpmTask fields correctly', () => {
    const t = task('A', {
      start: '2025-03-01',
      finish: '2025-03-05',
      baselineFinish: '2025-03-04',
      isMilestone: true,
      name: 'Launch',
    });
    const { tasks: subTasks } = buildSubgraph('A', [t], []);
    const ct = subTasks[0];
    expect(ct.earlyStart).toBe('2025-03-01');
    expect(ct.earlyFinish).toBe('2025-03-05');
    expect(ct.lateFinish).toBe('2025-03-04'); // uses baselineFinish as lateFinish approximation
    expect(ct.isMilestone).toBe(true);
    expect(ct.name).toBe('Launch');
  });

  it('falls back to finish when baselineFinish is absent', () => {
    const t = task('A', { finish: '2025-03-05' }); // no baselineFinish
    const { tasks: subTasks } = buildSubgraph('A', [t], []);
    expect(subTasks[0].lateFinish).toBe('2025-03-05');
  });
});
