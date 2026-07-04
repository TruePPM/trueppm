import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useCurrentSprintTargets } from './useCurrentSprintTargets';

// ---- Mocks: the three data sources the hook composes ----------------------
let projects: Array<{ id: string; name: string; methodology: string }> = [
  { id: 'p1', name: 'Atlas', methodology: 'HYBRID' },
  { id: 'p2', name: 'Hoover Dam', methodology: 'WATERFALL' },
];
vi.mock('./useProjects', () => ({ useProjects: () => ({ data: projects }) }));

let inContextSprint: { id: string; name: string } | null = { id: 's1', name: 'Sprint 14' };
vi.mock('./useSprints', () => ({
  useActiveSprint: (pid: string | null) => ({ sprint: pid ? inContextSprint : null }),
}));

let myActiveSprints: Array<{
  project_id: string;
  project_name: string;
  sprint: { id: string; name: string };
}> = [];
vi.mock('./useMyActiveSprints', () => ({ useMyActiveSprints: () => ({ data: myActiveSprints }) }));

afterEach(() => {
  projects = [
    { id: 'p1', name: 'Atlas', methodology: 'HYBRID' },
    { id: 'p2', name: 'Hoover Dam', methodology: 'WATERFALL' },
  ];
  inContextSprint = { id: 's1', name: 'Sprint 14' };
  myActiveSprints = [];
  vi.clearAllMocks();
});

describe('useCurrentSprintTargets', () => {
  it('builds an in-context target that deep-links to the sprint board', () => {
    const { result } = renderHook(() => useCurrentSprintTargets('p1'));
    expect(result.current).toEqual([
      {
        projectId: 'p1',
        projectName: 'Atlas',
        sprintId: 's1',
        sprintName: 'Sprint 14',
        path: '/projects/p1/board?sprint=s1',
      },
    ]);
  });

  it('lists the in-context sprint first, then other teams, de-duplicated by sprint', () => {
    myActiveSprints = [
      // Same sprint as the in-context project — must be de-duplicated (not listed twice).
      { project_id: 'p1', project_name: 'Atlas', sprint: { id: 's1', name: 'Sprint 14' } },
      { project_id: 'p3', project_name: 'Zephyr', sprint: { id: 's9', name: 'Sprint 3' } },
    ];
    const { result } = renderHook(() => useCurrentSprintTargets('p1'));
    expect(result.current.map((t) => t.sprintId)).toEqual(['s1', 's9']);
    expect(result.current[1]).toMatchObject({
      projectId: 'p3',
      projectName: 'Zephyr',
      path: '/projects/p3/board?sprint=s9',
    });
  });

  it('excludes the in-context sprint for a WATERFALL project (no DELIVER group, ADR-0195/0203)', () => {
    const { result } = renderHook(() => useCurrentSprintTargets('p2'));
    expect(result.current).toEqual([]);
  });

  it('returns cross-team targets even with no project in context (from anywhere)', () => {
    myActiveSprints = [
      { project_id: 'p3', project_name: 'Zephyr', sprint: { id: 's9', name: 'Sprint 3' } },
    ];
    const { result } = renderHook(() => useCurrentSprintTargets(null));
    expect(result.current).toEqual([
      {
        projectId: 'p3',
        projectName: 'Zephyr',
        sprintId: 's9',
        sprintName: 'Sprint 3',
        path: '/projects/p3/board?sprint=s9',
      },
    ]);
  });

  it('returns an empty list when there is no active sprint anywhere', () => {
    inContextSprint = null;
    myActiveSprints = [];
    const { result } = renderHook(() => useCurrentSprintTargets('p1'));
    expect(result.current).toEqual([]);
  });
});
