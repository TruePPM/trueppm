import { describe, it, expect } from 'vitest';
import {
  isTabVisibleForMethodology,
  groupedVisibleViews,
  VIEW_GROUPS,
  STANDALONE_LEADING,
  STANDALONE_TRAILING,
} from './methodologyTabs';

// Encodes the ADR-0041 visibility matrix as a single source of truth.
// Amended by ADR-0053: `wbs` and `list` consolidated into `grid`, visible in
// all three methodologies. Outline mode (formerly WBS) is the default for
// WATERFALL/HYBRID; Flat mode is the default for AGILE.
const MATRIX: Record<'WATERFALL' | 'AGILE' | 'HYBRID', Record<string, boolean>> = {
  WATERFALL: {
    overview: true,
    board: true,
    'product-backlog': false,
    sprints: false,
    schedule: true,
    grid: true,
    calendar: true,
    resources: true,
    risk: true,
  },
  AGILE: {
    overview: true,
    board: true,
    'product-backlog': true,
    sprints: true,
    schedule: false,
    grid: true,
    calendar: false,
    resources: true,
    risk: true,
  },
  HYBRID: {
    overview: true,
    board: true,
    'product-backlog': true,
    sprints: true,
    schedule: true,
    grid: true,
    calendar: true,
    resources: true,
    risk: true,
  },
};

describe('isTabVisibleForMethodology', () => {
  for (const [methodology, expectations] of Object.entries(MATRIX) as Array<
    [keyof typeof MATRIX, Record<string, boolean>]
  >) {
    for (const [view, expected] of Object.entries(expectations)) {
      it(`${methodology}: ${view} is ${expected ? 'visible' : 'hidden'}`, () => {
        expect(isTabVisibleForMethodology(view, methodology)).toBe(expected);
      });
    }
  }

  it('treats unknown views as visible (no false hides)', () => {
    // A future tab that hasn't been added to the matrix should default to
    // visible — methodology preset is a hide-list, not an allow-list.
    expect(isTabVisibleForMethodology('unknown-future-tab', 'WATERFALL')).toBe(true);
    expect(isTabVisibleForMethodology('unknown-future-tab', 'AGILE')).toBe(true);
    expect(isTabVisibleForMethodology('unknown-future-tab', 'HYBRID')).toBe(true);
  });
});

describe('groupedVisibleViews (ADR-0128)', () => {
  it('every grouped view (besides the standalones) has tab metadata coverage', () => {
    // Guards the "a view in no group silently never renders" risk: the standalone
    // leading/trailing views must NOT appear in any group.
    const grouped = VIEW_GROUPS.flatMap((g) => g.views);
    expect(grouped).not.toContain(STANDALONE_LEADING);
    expect(grouped).not.toContain(STANDALONE_TRAILING);
    // no view is double-assigned
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('HYBRID keeps every group fully populated', () => {
    const groups = groupedVisibleViews('HYBRID');
    expect(groups.map((g) => g.id)).toEqual(['PLAN', 'TRACK', 'PEOPLE']);
    expect(groups[0].visibleViews).toEqual(['product-backlog', 'sprints', 'schedule', 'grid', 'calendar']);
  });

  it('AGILE drops Schedule + Calendar from PLAN (ADR-0041 filter composes within the group)', () => {
    const plan = groupedVisibleViews('AGILE').find((g) => g.id === 'PLAN');
    expect(plan?.visibleViews).toEqual(['product-backlog', 'sprints', 'grid']);
  });

  it('WATERFALL drops Backlog + Sprints from PLAN', () => {
    const plan = groupedVisibleViews('WATERFALL').find((g) => g.id === 'PLAN');
    expect(plan?.visibleViews).toEqual(['schedule', 'grid', 'calendar']);
  });

  it('never returns a group with zero visible views', () => {
    for (const m of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      for (const g of groupedVisibleViews(m)) {
        expect(g.visibleViews.length).toBeGreaterThan(0);
      }
    }
  });
});
