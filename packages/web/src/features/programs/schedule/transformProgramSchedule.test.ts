import { describe, it, expect } from 'vitest';
import {
  transformProgramSchedule,
  laneIdFor,
  isLaneId,
  projectIdFromLaneId,
} from './transformProgramSchedule';
import type { ProgramSchedule } from '../hooks/useProgramSchedule';

function makeSchedule(overrides: Partial<ProgramSchedule> = {}): ProgramSchedule {
  return {
    program_id: 'prog-1',
    start_date: '2026-03-02',
    finish_date: '2026-05-01',
    projects: [
      { id: 'proj-a', name: 'Helios Platform', accessible: true },
      { id: 'proj-b', name: 'Helios Mobile', accessible: true },
    ],
    tasks: [
      {
        id: 't-a1',
        name: 'Design API',
        hex_id: 'A-1',
        project_id: 'proj-a',
        is_milestone: false,
        is_external: false,
        wbs_path: '1.1',
        early_start: '2026-03-02',
        early_finish: '2026-03-13',
        late_start: '2026-03-02',
        late_finish: '2026-03-13',
        total_float_days: 0,
        is_critical: true,
      },
      {
        id: 't-a2',
        name: 'Build service',
        hex_id: 'A-2',
        project_id: 'proj-a',
        is_milestone: false,
        is_external: false,
        wbs_path: '1.2',
        early_start: '2026-03-16',
        early_finish: '2026-03-27',
        late_start: '2026-03-16',
        late_finish: '2026-03-27',
        total_float_days: 0,
        is_critical: true,
      },
      {
        id: 't-b1',
        name: 'Integrate API',
        hex_id: 'B-1',
        project_id: 'proj-b',
        is_milestone: true,
        is_external: false,
        wbs_path: '1.1',
        early_start: '2026-03-30',
        early_finish: '2026-03-30',
        late_start: '2026-03-30',
        late_finish: '2026-03-30',
        total_float_days: 0,
        is_critical: true,
      },
    ],
    links: [
      {
        predecessor_id: 't-a1',
        successor_id: 't-a2',
        dep_type: 'FS',
        lag_days: 0,
        is_cross_project: false,
      },
      {
        predecessor_id: 't-a2',
        successor_id: 't-b1',
        dep_type: 'FS',
        lag_days: 0,
        is_cross_project: true,
      },
    ],
    critical_path: ['t-a1', 't-a2', 't-b1'],
    cross_project_edge_count: 1,
    ...overrides,
  };
}

describe('transformProgramSchedule', () => {
  it('emits a synthetic lane summary per project, then its tasks, in order', () => {
    const { tasks } = transformProgramSchedule(makeSchedule());
    expect(tasks.map((t) => t.id)).toEqual([
      laneIdFor('proj-a'),
      't-a1',
      't-a2',
      laneIdFor('proj-b'),
      't-b1',
    ]);
    const laneA = tasks[0];
    expect(laneA.isSummary).toBe(true);
    expect(laneA.parentId).toBeNull();
    expect(laneA.name).toBe('Helios Platform');
  });

  it('spans each lane summary over its children min/max dates', () => {
    const { tasks } = transformProgramSchedule(makeSchedule());
    const laneA = tasks.find((t) => t.id === laneIdFor('proj-a'));
    expect(laneA?.start).toBe('2026-03-02'); // min child early_start
    expect(laneA?.finish).toBe('2026-03-27'); // max child early_finish
  });

  it('reparents each task under its project lane', () => {
    const { tasks } = transformProgramSchedule(makeSchedule());
    const a1 = tasks.find((t) => t.id === 't-a1');
    const b1 = tasks.find((t) => t.id === 't-b1');
    expect(a1?.parentId).toBe(laneIdFor('proj-a'));
    expect(b1?.parentId).toBe(laneIdFor('proj-b'));
  });

  it('seeds plannedStart from early_start so tasks anchor dependency arrows', () => {
    const { tasks } = transformProgramSchedule(makeSchedule());
    const a1 = tasks.find((t) => t.id === 't-a1');
    expect(a1?.plannedStart).toBe('2026-03-02');
    expect(a1?.start).toBe('2026-03-02');
    expect(a1?.finish).toBe('2026-03-13');
  });

  it('carries server is_critical onto tasks and is_milestone', () => {
    const { tasks } = transformProgramSchedule(makeSchedule());
    expect(tasks.find((t) => t.id === 't-a1')?.isCritical).toBe(true);
    expect(tasks.find((t) => t.id === 't-b1')?.isMilestone).toBe(true);
  });

  it('flags cross-project links and derives link criticality from the critical path', () => {
    const { links } = transformProgramSchedule(makeSchedule());
    expect(links).toHaveLength(2);
    const within = links.find((l) => l.sourceId === 't-a1');
    const cross = links.find((l) => l.sourceId === 't-a2');
    expect(within?.crossProject).toBe(false);
    expect(cross?.crossProject).toBe(true);
    // Both endpoints on the critical path → link is critical.
    expect(cross?.isCritical).toBe(true);
  });

  it('maps redacted external tasks by their title and marks them isExternal', () => {
    const schedule = makeSchedule({
      projects: [
        { id: 'proj-a', name: 'Helios Platform', accessible: true },
        { id: 'proj-b', name: 'Helios Mobile', accessible: false },
      ],
      tasks: [
        {
          id: 't-ext',
          title: 'Locked-away work',
          hex_id: 'B-9',
          project_id: 'proj-b',
          project_name: 'Helios Mobile',
          is_milestone: false,
          is_external: true,
          early_start: '2026-04-01',
          early_finish: '2026-04-10',
          is_critical: false,
        },
      ],
      links: [],
      critical_path: [],
    });
    const { tasks } = transformProgramSchedule(schedule);
    const ext = tasks.find((t) => t.id === 't-ext');
    expect(ext?.isExternal).toBe(true);
    expect(ext?.name).toBe('Locked-away work'); // title, not name
    expect(ext?.start).toBe('2026-04-01');
  });

  it('keeps a lane row even when the project has no tasks', () => {
    const schedule = makeSchedule({ tasks: [], links: [], critical_path: [] });
    const { tasks } = transformProgramSchedule(schedule);
    expect(tasks.map((t) => t.id)).toEqual([laneIdFor('proj-a'), laneIdFor('proj-b')]);
    expect(tasks[0].start).toBe(''); // no children → empty span
  });

  it('lane-id helpers round-trip', () => {
    expect(isLaneId(laneIdFor('proj-a'))).toBe(true);
    expect(isLaneId('t-a1')).toBe(false);
    expect(projectIdFromLaneId(laneIdFor('proj-a'))).toBe('proj-a');
  });
});
