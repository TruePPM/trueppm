import { describe, it, expect } from 'vitest';
import {
  applyRoleContextLensOrder,
  lensDefaultView,
  lensTaskDeepLinkView,
  taskDeepLinkPath,
} from './lensOrder';
import type { VisibleViewGroup } from './methodologyTabs';

/** A HYBRID-shaped rail (every view visible) to exercise the ordering — the ADR-0942
 *  taxonomy: three verb bands in lifecycle order, then the WORKSPACE scope band. */
function groups(): VisibleViewGroup[] {
  return [
    {
      id: 'PLAN',
      kind: 'verb',
      label: 'Plan',
      views: ['schedule', 'grid', 'calendar'],
      visibleViews: ['schedule', 'grid', 'calendar'],
    },
    {
      id: 'DELIVER',
      kind: 'verb',
      label: 'Deliver',
      views: ['product-backlog', 'sprints', 'board'],
      visibleViews: ['product-backlog', 'sprints', 'board'],
    },
    {
      id: 'TRACK',
      kind: 'verb',
      label: 'Track',
      views: ['overview', 'today', 'risk', 'reports'],
      visibleViews: ['overview', 'today', 'risk', 'reports'],
    },
    {
      id: 'WORKSPACE',
      kind: 'scope',
      label: 'Workspace',
      views: ['resources', 'settings'],
      visibleViews: ['resources', 'settings'],
    },
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
    // DELIVER / TRACK / WORKSPACE unaffected — no PM-priority views there.
    expect(out.find((g) => g.id === 'DELIVER')!.visibleViews).toEqual([
      'product-backlog',
      'sprints',
      'board',
    ]);
    expect(out.find((g) => g.id === 'TRACK')!.visibleViews).toEqual([
      'overview',
      'today',
      'risk',
      'reports',
    ]);
  });

  it('Scrum Master promotes Board · Sprints · Backlog within the DELIVER band (ADR-0195/0203)', () => {
    const out = applyRoleContextLensOrder(groups(), 'scrum_master');
    // priority order is [board, sprints, product-backlog]; all three now share the DELIVER
    // group, so the lens reorders within it (daily-driver Board first for the SM).
    const sprint = out.find((g) => g.id === 'DELIVER')!;
    expect(sprint.visibleViews).toEqual(['board', 'sprints', 'product-backlog']);
    // PLAN / TRACK unaffected — no SM-priority views there.
    expect(out.find((g) => g.id === 'PLAN')!.visibleViews).toEqual(['schedule', 'grid', 'calendar']);
    expect(out.find((g) => g.id === 'TRACK')!.visibleViews).toEqual([
      'overview',
      'today',
      'risk',
      'reports',
    ]);
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
      {
        id: 'PLAN',
        kind: 'verb',
        label: 'Plan',
        views: [],
        visibleViews: ['product-backlog', 'sprints', 'grid'],
      },
    ];
    const out = applyRoleContextLensOrder(agile, 'pm');
    // PM priority is schedule (absent) then grid (present) → grid leads, no schedule conjured.
    expect(out[0].visibleViews).toEqual(['grid', 'product-backlog', 'sprints']);
  });

  it('leaves the WORKSPACE scope band untouched under every lens (ADR-0942 §2)', () => {
    // A scope band is not a workflow — it is the project's own setup, not a lifecycle
    // step — so there is no workflow for a role lens to re-point. Asserted for both
    // non-identity lenses, since `unified` returns early and would pass vacuously.
    for (const lens of ['pm', 'scrum_master'] as const) {
      const out = applyRoleContextLensOrder(groups(), lens);
      const workspace = out.find((g) => g.id === 'WORKSPACE');
      expect(workspace?.visibleViews).toEqual(['resources', 'settings']);
      // Identity, not merely same-contents: the band object is passed straight through.
      expect(workspace).toBe(out[out.length - 1]);
    }
  });

  it('still reorders verb bands when a scope band is present', () => {
    // Guards the inverse of the rule above: skipping `kind !== 'verb'` must not
    // accidentally short-circuit the whole map.
    const out = applyRoleContextLensOrder(groups(), 'pm');
    expect(out.find((g) => g.id === 'PLAN')?.visibleViews).toEqual([
      'schedule',
      'grid',
      'calendar',
    ]);
    expect(out.find((g) => g.id === 'TRACK')?.visibleViews[0]).toBe('overview');
    const smOut = applyRoleContextLensOrder(groups(), 'scrum_master');
    expect(smOut.find((g) => g.id === 'DELIVER')?.visibleViews).toEqual([
      'board',
      'sprints',
      'product-backlog',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = groups();
    const planRef = input[0].visibleViews;
    applyRoleContextLensOrder(input, 'scrum_master');
    expect(input[0].visibleViews).toBe(planRef);
    expect(input[0].visibleViews).toEqual(['schedule', 'grid', 'calendar']);
  });
});

describe('lensTaskDeepLinkView (#2441)', () => {
  it('sends a task deep-link to the lens landing view when it has a task drawer', () => {
    expect(lensTaskDeepLinkView('pm')).toBe('schedule');
    expect(lensTaskDeepLinkView('scrum_master')).toBe('board');
  });

  it('falls back to the schedule when the landing view has no task drawer', () => {
    // `unified` lands on Today (ADR-0180), which never reads `?task=` — sending the
    // drawer link there would silently drop it.
    expect(lensDefaultView('unified')).toBe('today');
    expect(lensTaskDeepLinkView('unified')).toBe('schedule');
  });
});

describe('taskDeepLinkPath (#2441)', () => {
  it('composes the lens-appropriate drawer deep-link', () => {
    expect(taskDeepLinkPath('p1', 't1', 'scrum_master')).toBe('/projects/p1/board?task=t1');
    expect(taskDeepLinkPath('p1', 't1', 'pm')).toBe('/projects/p1/schedule?task=t1');
    expect(taskDeepLinkPath('p1', 't1', 'unified')).toBe('/projects/p1/schedule?task=t1');
  });
});
