import { describe, expect, it, vi } from 'vitest';

import type { CommandItem } from './commandItems';
import { buildCrossProjectViewItems, promoteTopMatches } from './searchRanking';

const item = (
  id: string,
  label: string,
  group: CommandItem['group'],
  tag: string,
): CommandItem => ({
  id,
  label,
  group,
  tag,
  run: () => undefined,
});

const task = item('task:1', 'Open task: Platform Core GA', 'task', 'Task');
const project = item('jump:project:p', 'Platform Core', 'jump', 'Project');
const program = item('jump:program:g', 'Platform Core Program', 'jump', 'Program');
const view = item('jump:programs', 'Platform Core Views', 'jump', 'View');

describe('promoteTopMatches', () => {
  it('hoists a project that equals the query above a task that merely starts with it', () => {
    const out = promoteTopMatches([task, project], 'Platform Core');
    expect(out.map((i) => i.id)).toEqual(['jump:project:p', 'task:1']);
    expect(out[0].group).toBe('best');
  });

  it('orders Project > Program > View, then exact before prefix', () => {
    const exactView = item('jump:v2', 'plat', 'jump', 'View');
    const exactProgram = item('jump:g2', 'plat', 'jump', 'Program');
    const out = promoteTopMatches([view, exactView, program, exactProgram, project, task], 'plat');
    expect(out.map((i) => i.id)).toEqual([
      'jump:project:p',
      'jump:g2',
      'jump:program:g',
      'jump:v2',
      'jump:programs',
      'task:1',
    ]);
  });

  it('does not promote mid-name substring matches or non-entity jump rows', () => {
    const mid = item('jump:project:m', 'The Platform Core', 'jump', 'Project');
    const settings = item('jump:settings', 'Platform settings', 'jump', 'Settings');
    const items = [task, mid, settings];
    expect(promoteTopMatches(items, 'platform')).toEqual([task, mid, settings].map((i) => i));
  });

  it('is a no-op for an empty query', () => {
    const items = [task, project];
    expect(promoteTopMatches(items, '  ')).toBe(items);
  });

  it('leaves non-promoted rows in their original order', () => {
    const a = item('a', 'Open task: x', 'task', 'Task');
    const out = promoteTopMatches([a, project, task], 'platform core');
    expect(out.map((i) => i.id)).toEqual(['jump:project:p', 'a', 'task:1']);
  });
});

describe('buildCrossProjectViewItems', () => {
  const go = vi.fn((path: string) => () => void path);
  const projects = [
    { id: 'w', name: 'Waterfall One', code: 'WF', methodology: 'WATERFALL' as const },
    { id: 'pc', name: 'Platform Core', code: 'PC', methodology: 'HYBRID' as const },
    { id: 'ag', name: 'Agile Two', code: 'AG', methodology: 'AGILE' as const },
  ];

  it('lists only projects whose methodology shows the view', () => {
    const out = buildCrossProjectViewItems(projects, 'Sprints', go);
    expect(out.map((i) => i.label)).toEqual(['Sprints — Platform Core', 'Sprints — Agile Two']);
    expect(out.every((i) => i.group === 'projectView' && i.tag === 'View')).toBe(true);
  });

  it('routes to the project view by key', () => {
    buildCrossProjectViewItems(projects, 'Sprints', go);
    expect(go).toHaveBeenCalledWith('/projects/PC/sprints');
  });

  it('puts prefix matches before substring matches', () => {
    const out = buildCrossProjectViewItems([projects[1]], 'ar', go);
    // "Board" no; "Calendar" contains "ar", "Dashboard" contains "ar"; no label starts with "ar"
    expect(out.length).toBeGreaterThan(0);
    const sched = buildCrossProjectViewItems([projects[1]], 'sch', go);
    expect(sched.map((i) => i.label)).toEqual(['Schedule — Platform Core']);
  });

  it('omits the role-gated Team view and returns nothing for an empty query or no projects', () => {
    expect(buildCrossProjectViewItems(projects, 'Team', go)).toEqual([]);
    expect(buildCrossProjectViewItems(projects, '', go)).toEqual([]);
    expect(buildCrossProjectViewItems(undefined, 'Sprints', go)).toEqual([]);
  });
});
