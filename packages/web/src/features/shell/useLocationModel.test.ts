import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route + data hooks are mutable fixtures so each test picks a route context.
let projectId: string | undefined = 'p1';
let programId: string | undefined;
let pathname = '/projects/p1/board';

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useLocation: () => ({ pathname }),
  };
});

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => projectId }));
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: () => programId }));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({
    data: projectId
      ? {
          id: projectId,
          name: 'Launch Site',
          program_detail: { id: 'prog-1', name: 'Apollo' },
          effective_methodology: 'HYBRID',
        }
      : undefined,
  }),
}));
// Records the id the model asked `GET /programs/{id}/` for — `undefined` means the
// request was never issued. #3469's acceptance criterion is literally "no failing
// program request", so the assertion has to be about the call, not the render.
const programFetchArgs: (string | undefined)[] = [];
vi.mock('@/hooks/useProgram', () => ({
  useProgram: (id: string | undefined) => {
    programFetchArgs.push(id);
    return id ? { data: { id, name: 'Apollo', color: '#3E8C6D', code: 'APL' } } : { data: undefined };
  },
}));
// The MEMBER-scoped program list. Mutable so a project member who is not a program
// member can be modelled by dropping `prog-1` from it (#3469).
let programsList: { id: string; name: string }[] = [];
vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => ({ data: programsList }),
}));
let projectUnavailable = false;
vi.mock('@/hooks/useProjectUnavailable', () => ({
  useProjectUnavailable: () => projectUnavailable,
}));
// Mutable so the off-project placeholder tests (#2102) can empty the membership.
let projectsList: { id: string; name: string }[] = [];
vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ data: projectsList }),
}));
// useGroupedProjectViews supplies labelFor for the project-route leaf.
vi.mock('@/features/shell/useGroupedProjectViews', () => ({
  useGroupedProjectViews: () => ({
    labelFor: (view: string) => ({ board: 'Board', overview: 'Overview' })[view] ?? view,
  }),
}));

import { useLocationModel } from './useLocationModel';

describe('useLocationModel (#1643)', () => {
  beforeEach(() => {
    projectId = 'p1';
    programId = undefined;
    pathname = '/projects/p1/board';
    projectUnavailable = false;
    programFetchArgs.length = 0;
    programsList = [
      { id: 'prog-1', name: 'Apollo' },
      { id: 'prog-2', name: 'Gemini' },
    ];
    projectsList = [
      { id: 'p1', name: 'Launch Site' },
      { id: 'p2', name: 'Rover' },
    ];
  });

  it('project route with a program: program + project segments, view leaf', () => {
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.suppressed).toBe(false);
    expect(result.current.program?.current?.name).toBe('Apollo');
    expect(result.current.project?.currentId).toBe('p1');
    expect(result.current.project?.currentName).toBe('Launch Site');
    // The methodology status phrase rides the project segment for the picker
    // subtitle (#1680; full phrase per #2619 — no bare-label + hardcoded suffix).
    expect(result.current.project?.currentMethodologyLabel).toBe('Hybrid methodology');
    expect(result.current.leaf).toBe('Board');
    // Switching a project preserves the active view segment.
    expect(result.current.project?.options.find((o) => o.id === 'p2')?.to).toBe(
      '/projects/p2/board',
    );
  });

  it('program route: program segment only, program-view leaf', () => {
    projectId = undefined;
    programId = 'prog-1';
    pathname = '/programs/prog-1/backlog';
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.program?.current?.name).toBe('Apollo');
    expect(result.current.project).toBeNull();
    expect(result.current.leaf).toBe('Backlog');
    // Jumping programs preserves the program view segment.
    expect(result.current.program?.options.find((o) => o.id === 'prog-2')?.to).toBe(
      '/programs/prog-2/backlog',
    );
  });

  it('global route: placeholder project segment (no current) + leaf (#2102, ADR-0508 D3)', () => {
    projectId = undefined;
    programId = undefined;
    pathname = '/me/work';
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.program).toBeNull();
    // Unanchored segment: full membership list, no current, options → Overview.
    expect(result.current.project?.currentId).toBeUndefined();
    expect(result.current.project?.currentName).toBeUndefined();
    expect(result.current.project?.currentMethodologyLabel).toBeUndefined();
    expect(result.current.project?.options.map((o) => o.to)).toEqual([
      '/projects/p1/overview',
      '/projects/p2/overview',
    ]);
    expect(result.current.leaf).toBe('My Work');
  });

  it('global route with a single project still yields the placeholder segment (#2102)', () => {
    projectId = undefined;
    programId = undefined;
    pathname = '/me/work';
    projectsList = [{ id: 'p1', name: 'Launch Site' }];
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.project?.currentId).toBeUndefined();
    expect(result.current.project?.options).toHaveLength(1);
  });

  it('global route with zero projects: leaf-only, both segments omitted (#2102)', () => {
    projectId = undefined;
    programId = undefined;
    pathname = '/me/work';
    projectsList = [];
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.program).toBeNull();
    expect(result.current.project).toBeNull();
    expect(result.current.leaf).toBe('My Work');
  });

  it('settings route: suppressed (project, program, and workspace settings)', () => {
    for (const p of [
      '/projects/p1/settings/general',
      '/programs/prog-1/settings',
      '/settings/workspace',
    ]) {
      pathname = p;
      const { result } = renderHook(() => useLocationModel());
      expect(result.current.suppressed).toBe(true);
    }
  });

  it('falls back to a title-cased leaf for an unmapped global route', () => {
    projectId = undefined;
    programId = undefined;
    pathname = '/somewhere';
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.leaf).toBe('Somewhere');
  });
});

/**
 * Membership shape 1 — a PROJECT member who is not a PROGRAM member (#3469).
 *
 * `program_detail` is served to any project member regardless of program
 * membership, so the model used to fire `GET /programs/{id}/` off it on every page
 * and then discard the 404: `current` stayed undefined while the segment itself was
 * still returned, and `LocationSwitcher` rendered it as a bare leading chevron.
 */
describe('useLocationModel — project member outside the program', () => {
  beforeEach(() => {
    projectId = 'p1';
    programId = undefined;
    pathname = '/projects/p1/board';
    projectUnavailable = false;
    programFetchArgs.length = 0;
    projectsList = [
      { id: 'p1', name: 'Launch Site' },
      { id: 'p2', name: 'Rover' },
    ];
    // The project's program is NOT in the member-scoped program list.
    programsList = [{ id: 'prog-2', name: 'Gemini' }];
  });

  it('omits the program segment entirely rather than rendering it empty', () => {
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.program).toBeNull();
    // The rest of the breadcrumb is unaffected — this is the coherent shape.
    expect(result.current.project?.currentId).toBe('p1');
    expect(result.current.project?.currentName).toBe('Launch Site');
    expect(result.current.leaf).toBe('Board');
  });

  it('never issues GET /programs/{id}/ for a program it holds no membership on', () => {
    renderHook(() => useLocationModel());
    expect(programFetchArgs).not.toContain('prog-1');
    expect(programFetchArgs.every((id) => id === undefined)).toBe(true);
  });

  it('still fetches the program when the caller IS a member', () => {
    programsList = [{ id: 'prog-1', name: 'Apollo' }];
    const { result } = renderHook(() => useLocationModel());
    expect(programFetchArgs).toContain('prog-1');
    expect(result.current.program?.current?.name).toBe('Apollo');
  });

  it('renders the program segment from the list row before the detail read lands', () => {
    // `useProgram` returning undefined models the pre-load tick; the list row is
    // enough to draw the segment, so it must not pop in.
    programsList = [{ id: 'prog-1', name: 'Apollo' }];
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.program?.current?.id).toBe('prog-1');
  });
});

/**
 * Membership shape 2 — a PROGRAM member with no membership on the project they
 * clicked through to (#3469). The switcher must not name a view of a project that
 * is not there ("› Dashboard" was the reported symptom), and must not name the
 * program either, since it reached this project without being able to open it.
 */
describe('useLocationModel — project unavailable', () => {
  beforeEach(() => {
    projectUnavailable = true;
    programId = undefined;
    pathname = '/projects/p-missing/board';
    projectId = 'p-missing';
    programFetchArgs.length = 0;
    programsList = [
      { id: 'prog-1', name: 'Apollo' },
      { id: 'prog-2', name: 'Gemini' },
    ];
    projectsList = [
      { id: 'p1', name: 'Launch Site' },
      { id: 'p2', name: 'Rover' },
    ];
  });

  it('reports the terminal state as the leaf instead of a view name', () => {
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.leaf).toBe('Project unavailable');
    expect(result.current.leaf).not.toBe('Board');
  });

  it('omits the program segment and issues no program request', () => {
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.program).toBeNull();
    expect(programFetchArgs.every((id) => id === undefined)).toBe(true);
  });

  it('falls back to the off-project jump picker rather than anchoring to a nameless project', () => {
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.project?.currentId).toBeUndefined();
    expect(result.current.project?.currentName).toBeUndefined();
    expect(result.current.project?.currentMethodologyLabel).toBeUndefined();
    // The jump options are still there — the switcher stays useful.
    expect(result.current.project?.options.map((o) => o.id)).toEqual(['p1', 'p2']);
  });

  it('collapses to the leaf alone when the caller has no projects at all', () => {
    projectsList = [];
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.project).toBeNull();
    expect(result.current.leaf).toBe('Project unavailable');
  });
});
