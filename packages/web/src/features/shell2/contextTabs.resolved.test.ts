import { describe, expect, it } from 'vitest';
import type { ResolvedView } from '@/api/types';
import { resolveContextTabs } from './contextTabs';

const KEYS = [
  'overview',
  'schedule',
  'grid',
  'calendar',
  'product-backlog',
  'sprints',
  'board',
  'today',
  'risk',
  'reports',
  'activity',
  'assets',
  'resources',
  'settings',
];

function views(over: Record<string, Partial<ResolvedView>>): ResolvedView[] {
  return KEYS.map((key) => ({
    key,
    visible: true,
    source: 'default',
    binding: 'advisory',
    lens: null,
    at: null,
    ...over[key],
  }));
}

const base = {
  scope: 'project' as const,
  basePath: '/projects/ATL',
  activeView: 'overview',
  // Deliberately contradicts the resolved set: with `resolved` the client never
  // re-derives precedence, so these must be ignored.
  visibleViews: [] as string[],
  userHiddenViews: ['risk'],
  labelFor: (v: string) => v,
};

describe('resolveContextTabs with a server-resolved set (ADR-1478)', () => {
  it('renders exactly what the server resolved, ignoring client hides', () => {
    const model = resolveContextTabs({
      ...base,
      resolved: views({
        schedule: { visible: false, source: 'seed', lens: 'scrum_master' },
        calendar: { visible: false, source: 'methodology' },
      }),
    });
    const plan = model.tabs.find((t) => t.key === 'plan');
    expect(plan?.toggles.map((t) => t.view)).toEqual(['grid']);
    expect(model.tabs.map((t) => t.key)).toContain('risks');
  });

  it('lists seed- and user-hidden views under More with their source', () => {
    const model = resolveContextTabs({
      ...base,
      resolved: views({
        schedule: { visible: false, source: 'seed', lens: 'scrum_master' },
        risk: { visible: false, source: 'user' },
        sprints: { visible: false, source: 'methodology' },
      }),
    });
    expect(model.hidden.map((h) => [h.view, h.source, h.lens])).toEqual([
      ['schedule', 'seed', 'scrum_master'],
      ['risk', 'user', null],
    ]);
    // Methodology defaults are advisory but are not "hidden by" anyone.
    expect(model.hidden.some((h) => h.view === 'sprints')).toBe(false);
  });

  it('lists enforced views as off, never as openable', () => {
    const model = resolveContextTabs({
      ...base,
      resolved: views({ risk: { visible: false, source: 'capability', binding: 'enforced' } }),
    });
    expect(model.off.map((t) => t.view)).toEqual(['risk']);
    expect(model.hidden).toEqual([]);
  });

  it('still applies role and surface gates', () => {
    const model = resolveContextTabs({
      ...base,
      resolved: views({ resources: { visible: false, source: 'user' } }),
      allows: (v) => v !== 'resources' && v !== 'settings',
    });
    expect(model.tabs.some((t) => t.key === 'people')).toBe(false);
    expect(model.more.some((t) => t.view === 'settings')).toBe(false);
    expect(model.hidden).toEqual([]);
  });

  it('keeps the legacy composition when no resolved set is passed (fail-open path)', () => {
    const model = resolveContextTabs({ ...base, visibleViews: ['overview', 'risk'] });
    expect(model.tabs.some((t) => t.key === 'risks')).toBe(false);
    expect(model.hidden).toEqual([]);
  });
});
