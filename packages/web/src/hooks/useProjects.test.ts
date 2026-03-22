import { describe, expect, it } from 'vitest';
import { useProjects } from './useProjects';
import { FIXTURE_PROJECTS } from '@/fixtures/projects';

describe('useProjects (stub)', () => {
  it('returns fixture data', () => {
    const { data, isLoading, error } = useProjects();
    expect(data).toBe(FIXTURE_PROJECTS);
    expect(isLoading).toBe(false);
    expect(error).toBeNull();
  });

  it('returns all four health states in fixture', () => {
    const { data } = useProjects();
    const states = new Set(data?.map((p) => p.healthState));
    expect(states.has('on-track')).toBe(true);
    expect(states.has('at-risk')).toBe(true);
    expect(states.has('critical')).toBe(true);
    expect(states.has('unknown')).toBe(true);
  });
});
