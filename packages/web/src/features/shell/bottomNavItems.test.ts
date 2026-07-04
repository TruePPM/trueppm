import { describe, it, expect } from 'vitest';
import {
  selectMobileNav,
  MOBILE_RAIL_SLOTS,
  MOBILE_PRIMARY_PRIORITY,
  CANONICAL_VIEW_ORDER,
} from './bottomNavItems';

// Unit spec for the pure ADR-0196 mobile rail split. Encodes the two
// invariants that matter for issue 1464: (a) overview + today never get buried,
// (b) once the reachable set exceeds 5 the rail caps at 4 primary tabs + a More
// button, with Backlog/Risks/Reports landing in the overflow rather than being
// dropped entirely (the pre-1464 bug).

describe('selectMobileNav', () => {
  it('renders every view as primary when the reachable set fits in the rail', () => {
    const reachable = ['overview', 'today', 'board', 'grid', 'settings'];
    const { primary, overflow } = selectMobileNav(reachable, 'HYBRID');
    expect(primary).toEqual(['overview', 'today', 'board', 'grid', 'settings']);
    expect(overflow).toEqual([]);
  });

  it('caps the primary rail at 4 tabs + a More button when the set overflows', () => {
    const reachable = [
      'overview',
      'today',
      'board',
      'product-backlog',
      'sprints',
      'grid',
      'settings',
    ];
    const { primary, overflow } = selectMobileNav(reachable, 'HYBRID');
    // 4 primary + a More button (rendered by the caller) = MOBILE_RAIL_SLOTS.
    expect(primary).toHaveLength(MOBILE_RAIL_SLOTS - 1);
    expect(primary.length + 1).toBe(MOBILE_RAIL_SLOTS);
    expect(overflow.length).toBeGreaterThan(0);
    // Nothing is dropped — every reachable view is either primary or overflow.
    expect(new Set([...primary, ...overflow])).toEqual(new Set(reachable));
  });

  it('always leads with overview then today (issue 1324 — Today is never buried)', () => {
    const reachable = [
      'overview',
      'today',
      'board',
      'product-backlog',
      'sprints',
      'schedule',
      'grid',
      'settings',
    ];
    for (const methodology of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      const { primary } = selectMobileNav(reachable, methodology);
      expect(primary[0]).toBe('overview');
      expect(primary[1]).toBe('today');
    }
  });

  it('promotes board + backlog for AGILE/HYBRID (the daily sprint pair)', () => {
    const reachable = [
      'overview',
      'today',
      'board',
      'product-backlog',
      'sprints',
      'grid',
      'risk',
      'reports',
      'settings',
    ];
    for (const methodology of ['AGILE', 'HYBRID'] as const) {
      const { primary } = selectMobileNav(reachable, methodology);
      expect(primary).toEqual(['overview', 'today', 'board', 'product-backlog']);
    }
  });

  it('promotes schedule + grid for WATERFALL (the schedule-first pair)', () => {
    const reachable = [
      'overview',
      'today',
      'board',
      'schedule',
      'grid',
      'calendar',
      'risk',
      'reports',
      'settings',
    ];
    const { primary } = selectMobileNav(reachable, 'WATERFALL');
    expect(primary).toEqual(['overview', 'today', 'schedule', 'grid']);
  });

  it('makes Backlog, Risks, and Reports reachable via overflow (issue 1464 acceptance)', () => {
    // The exact bug: these three were omitted entirely from the old rail.
    const reachable = [
      'overview',
      'today',
      'board',
      'product-backlog',
      'sprints',
      'grid',
      'calendar',
      'resources',
      'risk',
      'reports',
      'settings',
    ];
    const { primary, overflow } = selectMobileNav(reachable, 'HYBRID');
    const all = [...primary, ...overflow];
    expect(all).toContain('product-backlog');
    expect(all).toContain('risk');
    expect(all).toContain('reports');
    // Backlog is promoted (HYBRID daily pair); Risks/Reports land in overflow.
    expect(primary).toContain('product-backlog');
    expect(overflow).toContain('risk');
    expect(overflow).toContain('reports');
  });

  it('orders the overflow by canonical order with settings last', () => {
    const reachable = [
      'overview',
      'today',
      'board',
      'product-backlog',
      'settings',
      'reports',
      'risk',
      'resources',
      'calendar',
    ];
    const { overflow } = selectMobileNav(reachable, 'HYBRID');
    // Overflow follows CANONICAL_VIEW_ORDER, and settings sorts last within it.
    const canonicalRank = (v: string) => CANONICAL_VIEW_ORDER.indexOf(v);
    const ranks = overflow.map(canonicalRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(overflow[overflow.length - 1]).toBe('settings');
  });

  it('drops priority views that are not in the reachable set (no phantom tabs)', () => {
    // A WATERFALL project hides sprints/backlog; the priority list still names
    // board/schedule/grid — only reachable ones may appear.
    const reachable = ['overview', 'today', 'schedule', 'grid'];
    const { primary, overflow } = selectMobileNav(reachable, 'WATERFALL');
    expect(primary).toEqual(['overview', 'today', 'schedule', 'grid']);
    expect(overflow).toEqual([]);
    // Board is a priority view but absent from `reachable`, so it never renders.
    expect(primary).not.toContain('board');
  });

  it('every priority view is also present in the canonical order (self-consistency)', () => {
    for (const methodology of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      for (const view of MOBILE_PRIMARY_PRIORITY[methodology]) {
        expect(CANONICAL_VIEW_ORDER).toContain(view);
      }
    }
  });

  // Issue 1591 — user pins promote chosen views into the primary rail ahead of
  // the methodology defaults, without ever burying Overview/Today.
  describe('user pins (issue 1591)', () => {
    it('promotes a pinned overflow view into the primary rail', () => {
      // AGILE would park Schedule in the overflow; pinning it makes it primary.
      const reachable = [
        'overview',
        'today',
        'board',
        'product-backlog',
        'sprints',
        'schedule',
        'grid',
        'risk',
        'reports',
        'settings',
      ];
      const { primary, overflow } = selectMobileNav(reachable, 'AGILE', ['schedule']);
      expect(primary).toContain('schedule');
      // Pins sit right after the anchors, ahead of the methodology defaults.
      expect(primary.slice(0, 3)).toEqual(['overview', 'today', 'schedule']);
      expect(overflow).not.toContain('schedule');
    });

    it('never displaces the Overview/Today anchors, even with multiple pins', () => {
      const reachable = [
        'overview',
        'today',
        'board',
        'product-backlog',
        'schedule',
        'grid',
        'risk',
        'reports',
        'settings',
      ];
      const { primary } = selectMobileNav(reachable, 'AGILE', ['risk', 'reports']);
      expect(primary[0]).toBe('overview');
      expect(primary[1]).toBe('today');
      // Both pins claimed the remaining two primary slots, in pin order.
      expect(primary).toEqual(['overview', 'today', 'risk', 'reports']);
    });

    it('ignores pins that are not in the reachable set (no phantom tabs)', () => {
      const reachable = ['overview', 'today', 'schedule', 'grid'];
      const { primary, overflow } = selectMobileNav(reachable, 'WATERFALL', ['board', 'risk']);
      // board/risk are unreachable, so the WATERFALL default stands.
      expect(primary).toEqual(['overview', 'today', 'schedule', 'grid']);
      expect(overflow).toEqual([]);
    });

    it('falls back to the methodology default when nothing is pinned', () => {
      const reachable = [
        'overview',
        'today',
        'board',
        'schedule',
        'grid',
        'risk',
        'reports',
        'settings',
      ];
      expect(selectMobileNav(reachable, 'WATERFALL', []).primary).toEqual(
        selectMobileNav(reachable, 'WATERFALL').primary,
      );
    });
  });
});
