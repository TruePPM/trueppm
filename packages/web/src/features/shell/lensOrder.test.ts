import { describe, it, expect } from 'vitest';
import { applyRoleContextLensOrder, lensDefaultView } from './lensOrder';
import type { VisibleViewGroup } from './methodologyTabs';

/** A HYBRID-shaped bar (every view visible) to exercise the ordering — ADR-0195/0203 layout:
 *  the sprint circuit (Backlog · Sprints · Board) lives in the dedicated DELIVER group. */
function groups(): VisibleViewGroup[] {
  return [
    {
      id: 'PLAN',
      label: 'Plan',
      views: ['schedule', 'grid', 'calendar'],
      visibleViews: ['schedule', 'grid', 'calendar'],
    },
    {
      id: 'DELIVER',
      label: 'Deliver',
      views: ['product-backlog', 'sprints', 'board'],
      visibleViews: ['product-backlog', 'sprints', 'board'],
    },
    { id: 'TRACK', label: 'Track', views: ['today', 'risk', 'reports'], visibleViews: ['today', 'risk', 'reports'] },
    { id: 'PEOPLE', label: 'People', views: ['resources'], visibleViews: ['resources'] },
  ];
}

describe('lensDefaultView', () => {
  it('maps each lens to its project-entry view', () => {
    expect(lensDefaultView('unified')).toBe('today'); // ADR-0180: the Unified Today view
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
    expect(plan.visibleViews).toEqual(['schedule', 'grid', 'calendar']);
    // DELIVER / TRACK / PEOPLE unaffected — no PM-priority views there.
    expect(out.find((g) => g.id === 'DELIVER')!.visibleViews).toEqual([
      'product-backlog',
      'sprints',
      'board',
    ]);
    expect(out.find((g) => g.id === 'TRACK')!.visibleViews).toEqual(['today', 'risk', 'reports']);
  });

  it('Scrum Master promotes Board · Sprints · Backlog within the DELIVER group (ADR-0195/0203)', () => {
    const out = applyRoleContextLensOrder(groups(), 'scrum_master');
    // priority order is [board, sprints, product-backlog]; all three now share the DELIVER
    // group, so the lens reorders within it (daily-driver Board first for the SM).
    const sprint = out.find((g) => g.id === 'DELIVER')!;
    expect(sprint.visibleViews).toEqual(['board', 'sprints', 'product-backlog']);
    // PLAN / TRACK unaffected — no SM-priority views there.
    expect(out.find((g) => g.id === 'PLAN')!.visibleViews).toEqual(['schedule', 'grid', 'calendar']);
    expect(out.find((g) => g.id === 'TRACK')!.visibleViews).toEqual(['today', 'risk', 'reports']);
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
    expect(input[0].visibleViews).toEqual(['schedule', 'grid', 'calendar']);
  });
});
