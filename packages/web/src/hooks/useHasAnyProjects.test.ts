import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const projects = vi.hoisted<{ current: { id: string }[] | undefined }>(() => ({ current: [] }));
const programs = vi.hoisted<{ current: { id: string; project_count?: number }[] | undefined }>(
  () => ({ current: [] }),
);
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

  it('is false while both queries are still loading', () => {
    projects.current = undefined;
    programs.current = undefined;
    const { result } = renderHook(() => useHasAnyProjects());
    expect(result.current).toBe(false);
  });
});
