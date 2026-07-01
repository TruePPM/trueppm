import { describe, it, expect } from 'vitest';
import {
  isTabVisibleForMethodology,
  groupedVisibleViews,
  groupedVisibleViewsForUser,
  surfaceHiddenViews,
  HIDEABLE_VIEW_KEYS,
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
    expect(groups[0].visibleViews).toEqual([
      'product-backlog',
      'sprints',
      'schedule',
      'grid',
      'calendar',
    ]);
  });

  it('today (ADR-0180) leads the TRACK group and is visible for every methodology', () => {
    for (const m of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      const track = groupedVisibleViews(m).find((g) => g.id === 'TRACK');
      expect(track?.visibleViews[0]).toBe('today');
    }
    // It is also a hideable view (unlike the always-on `overview`).
    expect(HIDEABLE_VIEW_KEYS.has('today')).toBe(true);
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

describe('HIDEABLE_VIEW_KEYS (ADR-0139)', () => {
  it('is every grouped view — and never the standalones', () => {
    const grouped = VIEW_GROUPS.flatMap((g) => g.views);
    expect([...HIDEABLE_VIEW_KEYS].sort()).toEqual([...grouped].sort());
    // overview (always-on landing) and settings (admin) are NOT hideable.
    expect(HIDEABLE_VIEW_KEYS.has(STANDALONE_LEADING)).toBe(false);
    expect(HIDEABLE_VIEW_KEYS.has(STANDALONE_TRAILING)).toBe(false);
  });
});

describe('groupedVisibleViewsForUser (ADR-0139)', () => {
  it('with no hidden views equals the plain methodology grouping', () => {
    for (const m of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      expect(groupedVisibleViewsForUser(m, new Set())).toEqual(groupedVisibleViews(m));
    }
  });

  it('removes a personally-hidden view from its group', () => {
    const groups = groupedVisibleViewsForUser('HYBRID', new Set(['schedule', 'calendar']));
    const plan = groups.find((g) => g.id === 'PLAN');
    expect(plan?.visibleViews).toEqual(['product-backlog', 'sprints', 'grid']);
  });

  it('drops a group whose only views the user hid', () => {
    // PEOPLE has just `resources`; hiding it removes the whole group.
    const groups = groupedVisibleViewsForUser('HYBRID', new Set(['resources']));
    expect(groups.map((g) => g.id)).toEqual(['PLAN', 'TRACK']);
  });

  it('composes on top of the methodology filter — hiding an already-methodology-hidden view is a no-op', () => {
    // AGILE already hides schedule/calendar; the personal set cannot re-show them
    // and listing them changes nothing.
    const agile = groupedVisibleViewsForUser('AGILE', new Set(['schedule']));
    expect(agile).toEqual(groupedVisibleViews('AGILE'));
  });

  it('a hidden set covering every hideable view still never empties the bar (overview is standalone)', () => {
    // The function returns no groups, but overview is rendered outside groups by
    // ViewTabs, so the nav is never empty — this asserts the grouping contract.
    const groups = groupedVisibleViewsForUser('HYBRID', HIDEABLE_VIEW_KEYS);
    expect(groups).toEqual([]);
  });
});

describe('surfaceHiddenViews (ADR-0193, #956)', () => {
  it('returns ["reports"] when reporting is false', () => {
    expect(surfaceHiddenViews({ reporting: false })).toEqual(['reports']);
  });

  it('returns [] when reporting is true', () => {
    expect(surfaceHiddenViews({ reporting: true })).toEqual([]);
  });

  it('the other three surfaces do not contribute a tab-hide (they are in-view sub-surfaces)', () => {
    // time_tracking, baselines, monte_carlo gate components within a view, not
    // a tab entry — so they are not in the surfaceHiddenViews result. The function
    // only accepts { reporting }, so passing extra props is the type-level guarantee.
    expect(surfaceHiddenViews({ reporting: true })).not.toContain('schedule');
    expect(surfaceHiddenViews({ reporting: true })).not.toContain('board');
  });
});
