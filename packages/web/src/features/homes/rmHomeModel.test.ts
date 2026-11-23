import { describe, expect, it } from 'vitest';
import type { PeopleLoadResponse } from '@/api/types';
import { rmHomeState, rmScopeLine } from './rmHomeModel';

const payload = (over: Partial<PeopleLoadResponse> = {}): PeopleLoadResponse => ({
  as_of: '2026-03-02T09:00:00Z',
  window: { start: '2026-03-02', end: '2026-03-15' },
  weeks: ['2026-03-02', '2026-03-09'],
  scope: { project_count: 3, withheld_project_count: 1, program_id: null },
  people: [
    {
      resource_id: 'r1',
      name: 'Alice',
      initials: 'AL',
      job_role: '',
      overallocated: true,
      peak_load_pct: 120,
      project_count: 2,
      cells: [],
    },
  ],
  over_allocated_count: 1,
  reason: null,
  definitions: { load_pct: 'x', over_allocated_count: 'y' },
  ...over,
});

describe('rmHomeState', () => {
  it('error wins over everything', () => {
    expect(rmHomeState({ data: payload(), isLoading: false, isError: true })).toEqual({
      kind: 'error',
    });
  });

  it('is loading until data arrives', () => {
    expect(rmHomeState({ data: undefined, isLoading: true, isError: false }).kind).toBe('loading');
    expect(rmHomeState({ data: undefined, isLoading: false, isError: false }).kind).toBe('loading');
  });

  it('is empty with the server reason', () => {
    expect(
      rmHomeState({
        data: payload({ people: [], over_allocated_count: 0, reason: 'no_projects' }),
        isLoading: false,
        isError: false,
      }),
    ).toEqual({ kind: 'empty', reason: 'no_projects' });
  });

  it('is ready with the server counts, not recounted', () => {
    const state = rmHomeState({ data: payload(), isLoading: false, isError: false });
    expect(state).toEqual({
      kind: 'ready',
      overAllocated: 1,
      people: 1,
      projects: 3,
      withheldProjects: 1,
    });
    if (state.kind === 'ready') expect(rmScopeLine(state)).toBe('1 person · 3 projects');
  });
});
