import { describe, it, expect } from 'vitest';
import { resolveCreateTargets } from './createTargets';

const PID = '11111111-1111-1111-1111-111111111111';
const GID = '22222222-2222-2222-2222-222222222222';

function kinds(pathname: string) {
  return resolveCreateTargets(pathname).map((t) => t.kind);
}

describe('resolveCreateTargets (ADR-0130)', () => {
  it('board / grid / sprints → Task', () => {
    expect(kinds(`/projects/${PID}/board`)).toEqual(['task']);
    expect(kinds(`/projects/${PID}/grid`)).toEqual(['task']);
    expect(kinds(`/projects/${PID}/sprints`)).toEqual(['task']);
  });

  it('schedule → Task + Milestone (menu, task primary)', () => {
    expect(kinds(`/projects/${PID}/schedule`)).toEqual(['task', 'milestone']);
  });

  it('product-backlog → Story', () => {
    expect(kinds(`/projects/${PID}/product-backlog`)).toEqual(['story']);
  });

  it('any program route → Project', () => {
    expect(kinds(`/programs/${GID}/overview`)).toEqual(['project']);
    expect(kinds(`/programs/${GID}/projects`)).toEqual(['project']);
    expect(kinds(`/programs/${GID}`)).toEqual(['project']);
  });

  it('suppressed routes resolve to no targets', () => {
    for (const view of ['overview', 'calendar', 'reports', 'resources/roster', 'risk', 'settings/general']) {
      expect(kinds(`/projects/${PID}/${view}`)).toEqual([]);
    }
    expect(kinds('/me/work')).toEqual([]);
    expect(kinds('/')).toEqual([]); // workspace root — Sidebar owns project-create
  });

  it('labels are plain lowercase nouns (no WBS jargon)', () => {
    expect(resolveCreateTargets(`/projects/${PID}/board`)[0].label).toBe('task');
    expect(resolveCreateTargets(`/projects/${PID}/product-backlog`)[0].label).toBe('story');
    expect(resolveCreateTargets(`/programs/${GID}/overview`)[0].label).toBe('project');
  });

  it('ignores query strings and fragments', () => {
    expect(kinds(`/projects/${PID}/board?foo=1`)).toEqual(['task']);
    expect(kinds(`/projects/${PID}/schedule#x`)).toEqual(['task', 'milestone']);
  });
});
