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
vi.mock('@/hooks/useProgram', () => ({
  useProgram: (id: string | undefined) =>
    id ? { data: { id, name: 'Apollo', color: '#3E8C6D', code: 'APL' } } : { data: undefined },
}));
vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => ({
    data: [
      { id: 'prog-1', name: 'Apollo' },
      { id: 'prog-2', name: 'Gemini' },
    ],
  }),
}));
vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    data: [
      { id: 'p1', name: 'Launch Site' },
      { id: 'p2', name: 'Rover' },
    ],
  }),
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
  });

  it('project route with a program: program + project segments, view leaf', () => {
    const { result } = renderHook(() => useLocationModel());
    expect(result.current.suppressed).toBe(false);
    expect(result.current.program?.current?.name).toBe('Apollo');
    expect(result.current.project?.currentId).toBe('p1');
    expect(result.current.project?.currentName).toBe('Launch Site');
    // The methodology label rides the project segment for the picker subtitle (#1680).
    expect(result.current.project?.currentMethodologyLabel).toBe('Hybrid');
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

  it('global route: leaf-only, both segments omitted', () => {
    projectId = undefined;
    programId = undefined;
    pathname = '/me/work';
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
