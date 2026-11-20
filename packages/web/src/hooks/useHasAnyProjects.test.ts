import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const projects = vi.hoisted<{ current: { id: string; myRole?: number | null }[] | undefined }>(
  () => ({ current: [] }),
);
const programs = vi.hoisted<{
  current: { id: string; project_count?: number; my_role?: number | null }[] | undefined;
}>(() => ({ current: [] }));
vi.mock('./useProjects', () => ({ useProjects: () => ({ data: projects.current }) }));
vi.mock('./usePrograms', () => ({ usePrograms: () => ({ data: programs.current }) }));

import { useHasAnyProjects } from './useHasAnyProjects';

describe('useHasAnyProjects (#3469)', () => {
  beforeEach(() => {
    projects.current = [];
    programs.current = [];
  });

  it('is true from the membership-scoped project list alone', () => {
    projects.current = [{ id: 'p1' }];
    const { result } = renderHook(() => useHasAnyProjects());
    expect(result.current).toBe(true);
  });

  it('is true for a program Owner holding no project membership', () => {
    // The reported case: `GET /projects/` is membership-scoped and returns [], so
    // counting only it told the owner of a four-project program "No projects yet".
    programs.current = [{ id: 'prog-1', project_count: 4 }];
    const { result } = renderHook(() => useHasAnyProjects());
    expect(result.current).toBe(true);
  });

  it('is false for a genuinely brand-new user', () => {
    // The state the onboarding empty state exists for must still be reachable.
    programs.current = [{ id: 'prog-1', project_count: 0 }];
    const { result } = renderHook(() => useHasAnyProjects());
    expect(result.current).toBe(false);
  });

  it('is false when a program row carries no count annotation', () => {
    // `project_count` is annotated by the list endpoint; an unannotated row is
    // unknown, and guessing "true" would suppress onboarding for a real new user.
    programs.current = [{ id: 'prog-1' }];
    const { result } = renderHook(() => useHasAnyProjects());
    expect(result.current).toBe(false);
  });

  it('is false when the only listed projects are WORKSPACE-visible non-member rows (ADR-1434)', () => {
    // `GET /projects/` now also lists other teams' WORKSPACE projects with
    // `my_role: null`; a brand-new user must still get the onboarding state.
    projects.current = [{ id: 'p-other', myRole: null }];
    programs.current = [{ id: 'prog-other', my_role: null, project_count: 3 }];
    const { result } = renderHook(() => useHasAnyProjects());
    expect(result.current).toBe(false);
  });

  it('is true when a member row sits among non-member rows', () => {
    projects.current = [
      { id: 'p-other', myRole: null },
      { id: 'p-mine', myRole: 100 },
    ];
    const { result } = renderHook(() => useHasAnyProjects());
    expect(result.current).toBe(true);
  });

  it('is false while both queries are still loading', () => {
    projects.current = undefined;
    programs.current = undefined;
    const { result } = renderHook(() => useHasAnyProjects());
    expect(result.current).toBe(false);
  });
});
