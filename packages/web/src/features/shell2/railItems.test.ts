import { describe, expect, it } from 'vitest';
import { resolveRailItems } from './railItems';

const base = { landingPath: '/me/work', programAgentsPath: null, inboxCount: 0, agentsCount: 0 };

describe('resolveRailItems', () => {
  it('yields four destinations off a program and five inside one, in rail order', () => {
    expect(resolveRailItems({ ...base, pathname: '/me/work' }).map((i) => i.key)).toEqual([
      'home',
      'inbox',
      'work',
      'people',
    ]);
    expect(
      resolveRailItems({
        ...base,
        pathname: '/programs/PM/overview',
        programAgentsPath: '/programs/PM/agents',
      }).map((i) => i.key),
    ).toEqual(['home', 'inbox', 'work', 'people', 'agents']);
  });

  it('points Home at the server-resolved landing and falls back to My Work', () => {
    expect(
      resolveRailItems({ ...base, pathname: '/x', landingPath: '/projects/ATL/overview' })[0].to,
    ).toBe('/projects/ATL/overview');
    expect(resolveRailItems({ ...base, pathname: '/x', landingPath: undefined })[0].to).toBe(
      '/me/work',
    );
    expect(resolveRailItems({ ...base, pathname: '/x', landingPath: '/' })[0].to).toBe('/me/work');
  });

  it('marks exactly one item active per route', () => {
    const active = (pathname: string, extra = {}) =>
      resolveRailItems({ ...base, pathname, ...extra })
        .filter((i) => i.active)
        .map((i) => i.key);
    expect(active('/me/work')).toEqual(['home']);
    expect(active('/me/notifications')).toEqual(['inbox']);
    expect(active('/programs')).toEqual(['work']);
    expect(active('/work')).toEqual(['work']);
    expect(active('/projects/ATL/schedule')).toEqual(['work']);
    expect(active('/resources')).toEqual(['people']);
    expect(active('/programs/PM/agents', { programAgentsPath: '/programs/PM/agents' })).toEqual([
      'agents',
    ]);
  });

  it('a project landing does not light Home while inside the work tree', () => {
    const items = resolveRailItems({
      ...base,
      pathname: '/projects/ATL/overview',
      landingPath: '/projects/ATL/overview',
    });
    expect(items.find((i) => i.key === 'home')?.active).toBe(false);
    expect(items.find((i) => i.key === 'work')?.active).toBe(true);
  });

  it('carries counts as badges only when non-zero', () => {
    const items = resolveRailItems({
      ...base,
      pathname: '/x',
      inboxCount: 4,
      agentsCount: 2,
      programAgentsPath: '/programs/PM/agents',
    });
    expect(items.find((i) => i.key === 'inbox')?.badge).toBe(4);
    expect(items.find((i) => i.key === 'agents')?.badge).toBe(2);
    expect(
      resolveRailItems({ ...base, pathname: '/x' }).find((i) => i.key === 'inbox')?.badge,
    ).toBeUndefined();
  });
});

describe('Work destination', () => {
  it('points the Work item at the full-page Work list', () => {
    const items = resolveRailItems({ ...base, pathname: '/me/work' });
    expect(items.find((i) => i.key === 'work')?.to).toBe('/work');
  });
});
