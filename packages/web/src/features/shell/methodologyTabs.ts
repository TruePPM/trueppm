import type { Methodology } from '@/types';

/**
 * Tab visibility matrix per methodology preset (ADR-0041, amended by ADR-0053).
 *
 * Matrix:
 * | Tab             | WATERFALL | AGILE | HYBRID |
 * |-----------------|-----------|-------|--------|
 * | overview        | ✅        | ✅    | ✅     |
 * | board           | ✅        | ✅    | ✅     |
 * | product-backlog | ❌        | ✅    | ✅     |
 * | sprints         | ❌        | ✅    | ✅     |
 * | schedule        | ✅        | ❌    | ✅     |
 * | grid            | ✅        | ✅    | ✅     |
 * | calendar        | ✅        | ❌    | ✅     |
 * | resources       | ✅        | ✅    | ✅     |
 * | risk            | ✅        | ✅    | ✅     |
 * | reports         | ✅        | ✅    | ✅     |
 *
 * `grid` replaces the legacy `wbs` + `list` entries (issue 334). Outline mode
 * inside Grid covers the WBS use case for WATERFALL and HYBRID; Flat mode is
 * the AGILE default (per `methodologyDefaultMode` in `features/grid/`).
 *
 * Tabs hidden by methodology are still reachable by direct URL — the preset
 * communicates "this is not how we work here", not "this is not allowed".
 */
const HIDDEN_FOR_METHODOLOGY: Record<Methodology, ReadonlySet<string>> = {
  WATERFALL: new Set(['sprints', 'product-backlog']),
  AGILE: new Set(['schedule', 'calendar']),
  HYBRID: new Set(),
};

export function isTabVisibleForMethodology(view: string, methodology: Methodology): boolean {
  return !HIDDEN_FOR_METHODOLOGY[methodology].has(view);
}

/**
 * v2 grouped view bar (ADR-0128) — the PLAN / TRACK / PEOPLE grouping that
 * replaces the flat tab strip. Grouping is **visual only**: the route segments are
 * unchanged (rule 108 / ADR-0030) and the methodology filter above still owns
 * visibility — `groupedVisibleViews` simply applies it *within* each group.
 *
 * `overview` (orientation landing) and `settings` (admin) stay **standalone** outside
 * the three groups — see `STANDALONE_LEADING` / `STANDALONE_TRAILING`.
 */
export type ViewGroupId = 'PLAN' | 'TRACK' | 'PEOPLE';

export interface ViewGroupDef {
  id: ViewGroupId;
  /** Spelled-out label used for the group's `aria-label` ("Plan views") and the
   *  visible mono header ("PLAN", uppercased at render). */
  label: string;
  /** Canonical view keys in display order (before the methodology filter). */
  views: readonly string[];
}

/** The leading standalone view (no group label) — the orientation landing (ADR-0030). */
export const STANDALONE_LEADING = 'overview';
/** The trailing standalone view (no group label) — project admin. */
export const STANDALONE_TRAILING = 'settings';

/**
 * Group → view assignment (ADR-0128 §A). Order here is the render order. Every
 * non-standalone view in `ViewTabs` must appear in exactly one group, or it will
 * silently never render.
 */
export const VIEW_GROUPS: readonly ViewGroupDef[] = [
  { id: 'PLAN', label: 'Plan', views: ['product-backlog', 'sprints', 'schedule', 'grid', 'calendar'] },
  { id: 'TRACK', label: 'Track', views: ['board', 'risk', 'reports'] },
  { id: 'PEOPLE', label: 'People', views: ['resources'] },
] as const;

export interface VisibleViewGroup extends ViewGroupDef {
  /** The group's views that survive the methodology filter, in order. */
  visibleViews: string[];
}

/**
 * Apply the methodology visibility matrix to the grouped layout. Pure (no role
 * gate — that stays in `ViewTabs`, as today) so it is trivially unit-testable.
 * Groups with no surviving views are dropped so the bar never renders an empty
 * group label (ADR-0128 §A).
 */
export function groupedVisibleViews(methodology: Methodology): VisibleViewGroup[] {
  return VIEW_GROUPS.map((g) => ({
    ...g,
    visibleViews: g.views.filter((v) => isTabVisibleForMethodology(v, methodology)),
  })).filter((g) => g.visibleViews.length > 0);
}
