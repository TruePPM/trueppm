import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const useProjectId = vi.fn();
const useProject = vi.fn();

vi.mock('./useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));
vi.mock('./useProject', () => ({
  useProject: (id: string | undefined) => useProject(id) as { data: unknown },
}));

import { useIterationLabel } from './useIterationLabel';

beforeEach(() => {
  vi.clearAllMocks();
  useProjectId.mockReturnValue('p-1');
});

describe('useIterationLabel', () => {
  it('derives all forms from the project label', () => {
    useProject.mockReturnValue({ data: { iteration_label: 'Iteration' } });
    const { result } = renderHook(() => useIterationLabel());
    expect(result.current).toMatchObject({
      singular: 'Iteration',
      plural: 'Iterations',
      lower: 'iteration',
      lowerPlural: 'iterations',
      possessive: "Iteration's",
    });
  });

  it('falls back to "Sprint" while the project is loading', () => {
    useProject.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useIterationLabel());
    expect(result.current.singular).toBe('Sprint');
    expect(result.current.plural).toBe('Sprints');
  });

  it('falls back to "Sprint" for a blank stored label', () => {
    useProject.mockReturnValue({ data: { iteration_label: '   ' } });
    const { result } = renderHook(() => useIterationLabel());
    expect(result.current.singular).toBe('Sprint');
  });

  it('uses the route project id by default', () => {
    useProject.mockReturnValue({ data: { iteration_label: 'PI' } });
    renderHook(() => useIterationLabel());
    expect(useProject).toHaveBeenCalledWith('p-1');
  });

  it('prefers an explicit project id over the route', () => {
    useProject.mockReturnValue({ data: { iteration_label: 'PI' } });
    renderHook(() => useIterationLabel('p-other'));
    expect(useProject).toHaveBeenCalledWith('p-other');
  });
});
