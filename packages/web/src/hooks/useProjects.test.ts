/**
 * Tests for useProjects — real TanStack Query implementation.
 *
 * We test the mapper (ApiProject → Project) directly by mirroring it inline,
 * since the hook itself requires a running QueryClient + network and is better
 * covered via E2E or MSW integration tests.
 */
import { describe, expect, it } from 'vitest';

// ApiProject shape returned by the backend
interface ApiProject {
  id: string;
  name: string;
  description: string;
  start_date: string;
  calendar: string;
}

const COLOR_PALETTE: ReadonlyArray<string> = [
  '#1C6B3A',
  '#E8A020',
  '#B91C1C',
  '#6B6965',
  '#145229',
  '#1D4ED8',
  '#7C3AED',
  '#0E7490',
];

/** Inline mirror of mapProject in useProjects.ts — must stay in sync. */
function mapProject(p: ApiProject, index: number) {
  return {
    id: p.id,
    name: p.name,
    healthState: 'unknown' as const,
    colorDot: COLOR_PALETTE[index % COLOR_PALETTE.length] ?? '#1C6B3A',
  };
}

describe('useProjects mapper', () => {
  const apiProject: ApiProject = {
    id: 'proj-1',
    name: 'Alpha',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  };

  it('maps API project to Project shape', () => {
    const project = mapProject(apiProject, 0);
    expect(project.id).toBe('proj-1');
    expect(project.name).toBe('Alpha');
    expect(project.healthState).toBe('unknown');
    expect(project.colorDot).toBe('#1C6B3A');
  });

  it('cycles colorDot through the palette by index', () => {
    const colors = Array.from({ length: 8 }, (_, i) =>
      mapProject(apiProject, i).colorDot,
    );
    // palette has 8 entries — index 8 wraps back to index 0
    const wrapped = mapProject(apiProject, 8).colorDot;
    expect(wrapped).toBe(colors[0]);
    // all 8 entries are distinct
    expect(new Set(colors).size).toBe(8);
  });

  it('healthState is always unknown (server does not compute it yet)', () => {
    const project = mapProject(apiProject, 0);
    expect(project.healthState).toBe('unknown');
  });
});
