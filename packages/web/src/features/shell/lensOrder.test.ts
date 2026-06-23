import { describe, it, expect } from 'vitest';
import { applyRoleContextLensOrder, lensDefaultView } from './lensOrder';
import type { VisibleViewGroup } from './methodologyTabs';

/** A HYBRID-shaped bar (every view visible) to exercise the ordering. */
function groups(): VisibleViewGroup[] {
  return [
    {
      id: 'PLAN',
      label: 'Plan',
      views: ['product-backlog', 'sprints', 'schedule', 'grid', 'calendar'],
      visibleViews: ['product-backlog', 'sprints', 'schedule', 'grid', 'calendar'],
    },
    { id: 'TRACK', label: 'Track', views: ['board', 'risk', 'reports'], visibleViews: ['board', 'risk', 'reports'] },
    { id: 'PEOPLE', label: 'People', views: ['resources'], visibleViews: ['resources'] },
  ];
}

describe('lensDefaultView', () => {
  it('maps each lens to its project-entry view', () => {
    expect(lensDefaultView('unified')).toBe('overview');
    expect(lensDefaultView('pm')).toBe('schedule');
    expect(lensDefaultView('scrum_master')).toBe('board');
  });
});

describe('applyRoleContextLensOrder', () => {
  it('unified is the identity transform (neutral default — no reorder)', () => {
    const input = groups();
    const out = applyRoleContextLensOrder(input, 'unified');
    expect(out.map((g) => g.visibleViews)).toEqual(input.map((g) => g.visibleViews));
  });

  it('PM promotes schedule then grid to the front of PLAN, rest keep order', () => {
    const out = applyRoleContextLensOrder(groups(), 'pm');
    const plan = out.find((g) => g.id === 'PLAN')!;
    expect(plan.visibleViews).toEqual(['schedule', 'grid', 'product-backlog', 'sprints', 'calendar']);
    // TRACK / PEOPLE unaffected — no PM-priority views there.
    expect(out.find((g) => g.id === 'TRACK')!.visibleViews).toEqual(['board', 'risk', 'reports']);
  });

  it('Scrum Master promotes sprints then product-backlog in PLAN; board already leads TRACK', () => {
    const out = applyRoleContextLensOrder(groups(), 'scrum_master');
    const plan = out.find((g) => g.id === 'PLAN')!;
    // priority order is [board, sprints, product-backlog]; board not in PLAN, so sprints leads.
    expect(plan.visibleViews).toEqual(['sprints', 'product-backlog', 'schedule', 'grid', 'calendar']);
    expect(out.find((g) => g.id === 'TRACK')!.visibleViews).toEqual(['board', 'risk', 'reports']);
  });

  it('never adds, removes, or moves a view across groups — only within-group order changes', () => {
    const before = groups();
    const out = applyRoleContextLensOrder(before, 'pm');
    before.forEach((g, i) => {
      expect(new Set(out[i].visibleViews)).toEqual(new Set(g.visibleViews));
      expect(out[i].id).toBe(g.id);
      expect(out[i].visibleViews).toHaveLength(g.visibleViews.length);
    });
  });

  it('only reorders already-present views — a hidden priority view is a no-op', () => {
    // AGILE-shaped PLAN: schedule/calendar already filtered out upstream.
    const agile: VisibleViewGroup[] = [
      { id: 'PLAN', label: 'Plan', views: [], visibleViews: ['product-backlog', 'sprints', 'grid'] },
    ];
    const out = applyRoleContextLensOrder(agile, 'pm');
    // PM priority is schedule (absent) then grid (present) → grid leads, no schedule conjured.
    expect(out[0].visibleViews).toEqual(['grid', 'product-backlog', 'sprints']);
  });

  it('does not mutate the input array', () => {
    const input = groups();
    const planRef = input[0].visibleViews;
    applyRoleContextLensOrder(input, 'scrum_master');
    expect(input[0].visibleViews).toBe(planRef);
    expect(input[0].visibleViews).toEqual(['product-backlog', 'sprints', 'schedule', 'grid', 'calendar']);
  });
});
