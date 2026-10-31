import { describe, it, expect } from 'vitest';
import { buildDepDescription } from './ScheduleAriaOverlay';
import type { Task, TaskLink } from '@/types';

function makeTask(id: string, name: string): Task {
  return {
    id,
    name,
    start: '2026-04-06',
    finish: '2026-04-20',
    duration: 14,
    isSummary: false,
    isComplete: false,
    isCritical: false,
    isMilestone: false,
    parentId: null,
    wbs: '1',
  } as unknown as Task;
}

function makeLink(
  id: string,
  sourceId: string,
  targetId: string,
  type: TaskLink['type'] = 'FS',
  lag = 0,
): TaskLink {
  return { id, sourceId, targetId, type, lag, isCritical: false } as unknown as TaskLink;
}

const taskA = makeTask('A', 'Design');
const taskB = makeTask('B', 'Build');
const taskC = makeTask('C', 'Deploy');
const tasks = [taskA, taskB, taskC];

describe('buildDepDescription (#1371 schedule dep edge a11y)', () => {
  it('returns an empty map when there are no links', () => {
    const result = buildDepDescription(tasks, []);
    expect(result.size).toBe(0);
  });

  it('omits tasks that have no incoming or outgoing links', () => {
    // A → B only; C has no links
    const links = [makeLink('l1', 'A', 'B')];
    const result = buildDepDescription(tasks, links);
    expect(result.has('C')).toBe(false);
  });

  it('announces FS predecessor with zero lag', () => {
    const links = [makeLink('l1', 'A', 'B', 'FS', 0)];
    const result = buildDepDescription(tasks, links);
    expect(result.get('B')).toBe('Depends on: Design (FS).');
  });

  it('annotates positive lag', () => {
    const links = [makeLink('l1', 'A', 'B', 'FS', 2)];
    const result = buildDepDescription(tasks, links);
    expect(result.get('B')).toBe('Depends on: Design (FS, +2d).');
  });

  it('annotates negative lag (lead)', () => {
    const links = [makeLink('l1', 'A', 'B', 'FS', -3)];
    const result = buildDepDescription(tasks, links);
    expect(result.get('B')).toBe('Depends on: Design (FS, -3d).');
  });

  it('announces SS link type', () => {
    const links = [makeLink('l1', 'A', 'B', 'SS', 0)];
    const result = buildDepDescription(tasks, links);
    expect(result.get('B')).toBe('Depends on: Design (SS).');
  });

  it('announces multiple predecessors', () => {
    const links = [makeLink('l1', 'A', 'C', 'FS', 0), makeLink('l2', 'B', 'C', 'FS', 1)];
    const result = buildDepDescription(tasks, links);
    const desc = result.get('C');
    expect(desc).toContain('Depends on:');
    expect(desc).toContain('Design (FS)');
    expect(desc).toContain('Build (FS, +1d)');
  });

  it('announces successors on the source task', () => {
    const links = [makeLink('l1', 'A', 'B', 'FS', 0)];
    const result = buildDepDescription(tasks, links);
    expect(result.get('A')).toBe('Leads to: Build (FS).');
  });

  it('combines predecessors and successors for a middle task', () => {
    const links = [makeLink('l1', 'A', 'B', 'FS', 0), makeLink('l2', 'B', 'C', 'FS', 0)];
    const result = buildDepDescription(tasks, links);
    const desc = result.get('B');
    expect(desc).toContain('Depends on: Design (FS)');
    expect(desc).toContain('Leads to: Deploy (FS)');
  });

  it('falls back to "Unknown task" for a task id not in the task list', () => {
    const linkToOrphan: TaskLink = {
      id: 'lx',
      sourceId: 'A',
      targetId: 'ORPHAN',
      type: 'FS',
      lag: 0,
      isCritical: false,
    } as unknown as TaskLink;
    const result = buildDepDescription([taskA], [linkToOrphan]);
    const desc = result.get('A');
    expect(desc).toContain('Unknown task');
  });
});

describe('buildDepDescription with rows hidden by a collapsed phase (#4507)', () => {
  const phase = { ...makeTask('P', 'Assess'), isSummary: true } as Task;
  const hiddenPred = { ...makeTask('H', 'Gather data'), parentId: 'P' } as Task;
  const nestedPhase = { ...makeTask('N', 'Inner'), isSummary: true, parentId: 'P' } as Task;
  const deepPred = { ...makeTask('D', 'Deep work'), parentId: 'N' } as Task;
  const target = makeTask('T', 'Dry-run migration');
  const all = [phase, hiddenPred, nestedPhase, deepPred, target];
  const visible = [phase, target];

  it('names a predecessor inside a collapsed phase and says which phase', () => {
    const result = buildDepDescription(visible, [makeLink('l1', 'H', 'T')], all, new Set());
    expect(result.get('T')).toBe('Depends on: Gather data (in collapsed phase Assess) (FS).');
  });

  it('uses the outermost collapsed ancestor for a deeply nested predecessor', () => {
    const result = buildDepDescription(visible, [makeLink('l1', 'D', 'T')], all, new Set());
    expect(result.get('T')).toBe('Depends on: Deep work (in collapsed phase Assess) (FS).');
  });

  it('names a hidden successor too', () => {
    const result = buildDepDescription(visible, [makeLink('l1', 'T', 'H')], all, new Set());
    expect(result.get('T')).toBe('Leads to: Gather data (in collapsed phase Assess) (FS).');
  });

  it('names a filter-hidden peer without claiming a collapsed phase', () => {
    const result = buildDepDescription([target], [makeLink('l1', 'H', 'T')], [hiddenPred, target]);
    expect(result.get('T')).toBe('Depends on: Gather data (FS).');
  });

  it('does not claim a collapsed phase for a filter-hidden child of an EXPANDED phase', () => {
    const result = buildDepDescription(
      visible,
      [makeLink('l1', 'H', 'T')],
      all,
      new Set(['P']),
    );
    expect(result.get('T')).toBe('Depends on: Gather data (FS).');
  });

  it('makes no collapsed-phase claim when expansion state is not supplied', () => {
    const result = buildDepDescription(visible, [makeLink('l1', 'H', 'T')], all);
    expect(result.get('T')).toBe('Depends on: Gather data (FS).');
  });

  it('reserves "Unknown task" for a genuinely dangling link', () => {
    const result = buildDepDescription(visible, [makeLink('l1', 'GONE', 'T')], all);
    expect(result.get('T')).toBe('Depends on: Unknown task (FS).');
  });
});
